#!/usr/bin/env bash
# Builds the Windows test client from scratch, with no manual step, and joins
# it to the domain of the DC built by build-dc.sh:
#   build-win.sh            (lab.sh build win)
# Windows Setup from WIN_ISO driven by win/autounattend.xml, then
# win/setup.ps1 at the first logon (OpenSSH Server, PowerShell as its shell):
# snapshot "baseline". Then, with the DC at samba_baseline: DNS pointed at the
# DC, joined as WIN_COMPUTER_NAME, snapshot "lab_baseline" of both VMs (they
# belong together: the DC holds the client's machine account). Leaves both
# shut off. 30-60 minutes.
# What fails where: Setup and OOBE show on the VM's screen (virt-viewer, or
# gui.sh shot); setup.ps1 logs to C:\Windows\Temp\cockpit-samba-setup.log.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
lab=$VM_DIR/lab.sh
die() { echo "build-win.sh: $*" >&2; exit 1; }

for v in WIN_ADMIN_PASSWORD DOMAIN_ADMIN_PASSWORD; do
    [[ -n ${!v:-} ]] || die "$v is not set in .env"
done
[[ -n ${WIN_ISO:-} && -f $WIN_ISO ]] || die "WIN_ISO in .env must name the Windows 11 Enterprise Evaluation ISO"
virsh dominfo "$WIN_VM" >/dev/null 2>&1 && die "$WIN_VM already exists: lab.sh rebuild win"
virsh snapshot-info "$DC_VM" samba_baseline >/dev/null 2>&1 || die "build the DC first (lab.sh build dc)"
"$lab" net
"$lab" resources win || die "not enough resources on the host to build $WIN_VM"

# The answer file holds the password in clear: it is built in a private
# directory, never in the work tree (which may be synced elsewhere), and goes
# straight into the pool, from which it is deleted at the end.
answer=$WIN_VM-unattend.iso
tmp=$(umask 077; mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/iso/cockpit-samba"
export WIN_ADMIN_USER WIN_ADMIN_PASSWORD WIN_LANG WIN_KEYBOARD WIN_TIMEZONE WIN_COMPUTER_NAME
"$VM_DIR/render.py" --xml "$VM_DIR/win/autounattend.xml" > "$tmp/iso/autounattend.xml"
cp "$VM_DIR/win/setup.ps1" "$tmp/iso/cockpit-samba/setup.ps1"
xorriso -as mkisofs -quiet -J -r -V CSAMBA -o "$tmp/unattend.iso" "$tmp/iso"
virsh vol-delete --pool "$LAB_POOL" "$answer" >/dev/null 2>&1 || true
virsh vol-create-as "$LAB_POOL" "$answer" "$(stat -c %s "$tmp/unattend.iso")b" --format raw >/dev/null
virsh vol-upload --pool "$LAB_POOL" "$answer" "$tmp/unattend.iso"
rm -rf "$tmp"

# Secure Boot with Microsoft's keys, TPM 2.0 and SMM: what Windows 11 Setup
# requires. SATA disk and e1000e NIC: drivers in the box, no virtio ISO.
# virt-install runs Setup with on_reboot=destroy and starts the VM again with
# the final configuration at its first reboot, only while it is still
# running: hence --wait in the background.
virt-install --name "$WIN_VM" --osinfo win11 \
    --memory "$WIN_MEM_MIB" --vcpus "$WIN_VCPUS" --cpu host-passthrough \
    --machine q35 --features smm.state=on \
    --boot uefi,firmware.feature0.name=secure-boot,firmware.feature0.enabled=yes,firmware.feature1.name=enrolled-keys,firmware.feature1.enabled=yes \
    --tpm backend.type=emulator,backend.version=2.0,model=tpm-crb \
    --disk "pool=$LAB_POOL,size=$WIN_DISK_GIB,format=qcow2,bus=sata" \
    --cdrom "$WIN_ISO" \
    --disk "vol=$LAB_POOL/$answer,device=cdrom,bus=sata" \
    --network "network=$LAB_NET,mac=$WIN_MAC,model=e1000e" \
    --graphics spice --video qxl --input tablet,bus=usb \
    --noautoconsole --wait=-1 >/dev/null &
installer=$!

# The firmware boots the ISO only if a key is pressed within a few seconds of
# its prompt. Stop soon: once Setup copies files its Cancel button has the
# focus, and a late Enter would abort the installation.
sleep 2
for _ in $(seq 1 15); do virsh send-key "$WIN_VM" KEY_ENTER >/dev/null 2>&1 || true; sleep 1; done
echo "$WIN_VM: Windows Setup running (20-40 minutes)"
wait "$installer" || die "virt-install failed"

# Until the first logon has installed OpenSSH: up to 90 minutes.
deadline=$(($(date +%s) + 5400))
until "$lab" ssh win exit </dev/null 2>/dev/null; do
    (( $(date +%s) < deadline )) || die "no SSH on $WIN_VM ($WIN_HOST) after 90 minutes: look at its screen"
    sleep 30
done
outcome=$("$lab" ssh win 'if (Test-Path C:\Windows\Temp\cockpit-samba-setup.done) { "done" } else { Get-Content C:\Windows\Temp\cockpit-samba-setup.log -Raw }' </dev/null)
[[ $outcome == done* ]] || die "setup.ps1 failed on $WIN_VM: $outcome"
eval_info=$("$lab" ssh win '$p = Get-CimInstance SoftwareLicensingProduct -Filter "PartialProductKey IS NOT NULL" | Where-Object Name -like "Windows*" | Select-Object -First 1; "$($p.Name), evaluation ends on $((Get-Date).AddMinutes($p.GracePeriodRemaining).ToString("yyyy-MM-dd"))"' </dev/null | tr -d '\r')
echo "$WIN_VM: $eval_info"

"$lab" ssh win 'shutdown.exe /s /t 5 /f' </dev/null >/dev/null || true
"$lab" stop win
# The snapshot keeps the domain's XML: with the media still attached, a
# revert would point at an answer volume that no longer exists.
for dev in $(virsh domblklist "$WIN_VM" --details | awk '$2 == "cdrom" && $4 != "-" {print $3}'); do
    virsh change-media "$WIN_VM" "$dev" --eject --config >/dev/null
done
virsh vol-delete --pool "$LAB_POOL" "$answer" >/dev/null
virsh snapshot-create-as "$WIN_VM" baseline \
    --description "$eval_info; $WIN_ADMIN_USER, OpenSSH Server; built by test/vm/build-win.sh" >/dev/null
echo "$WIN_VM: snapshot baseline"

# The join: the DC at samba_baseline, both running
"$lab" stop dc >/dev/null
virsh snapshot-revert "$DC_VM" samba_baseline
"$lab" resources dc win || die "not enough resources on the host to run $DC_VM and $WIN_VM together"
"$lab" start dc >/dev/null
"$lab" wait dc
"$lab" start win >/dev/null
"$lab" wait win
# Changing the DNS server keeps the SSH session; the password is read from
# stdin by PowerShell, never on a command line.
printf '%s\n' "$DOMAIN_ADMIN_PASSWORD" | "$lab" ssh win "
\$nic = Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -First 1
Set-DnsClientServerAddress -InterfaceIndex \$nic.ifIndex -ServerAddresses $DC_HOST
\$pw = ConvertTo-SecureString ([Console]::In.ReadLine()) -AsPlainText -Force
\$c = New-Object System.Management.Automation.PSCredential('$DOMAIN_NETBIOS\\Administrator', \$pw)
Add-Computer -DomainName ${DOMAIN_REALM,,} -Credential \$c -Force
Restart-Computer -Force"
sleep 30
"$lab" wait win
"$lab" ssh win "nltest /sc_verify:${DOMAIN_REALM,,} | Select-Object -Last 2" </dev/null

"$lab" stop win
"$lab" stop dc
virsh snapshot-create-as "$DC_VM" lab_baseline \
    --description "as samba_baseline, with $WIN_COMPUTER_NAME joined; built by test/vm/build-win.sh" >/dev/null
virsh snapshot-create-as "$WIN_VM" lab_baseline \
    --description "$WIN_COMPUTER_NAME joined to ${DOMAIN_REALM^^}, no user profiles; built by test/vm/build-win.sh" >/dev/null
echo "$WIN_VM built and joined: snapshots lab_baseline of both VMs, shut off"
