#!/usr/bin/env bash
# Builds the Windows test client from a clean Windows 11 disk that has the
# admin account of .env (WIN_ADMIN_USER) and OpenSSH, and joins it to the
# domain of the DC built by build-dc.sh:
#   build-win.sh SOURCE_VM SOURCE_DISK SOURCE_IP
# SOURCE_VM gives the hardware definition (UEFI, TPM, devices), SOURCE_DISK
# is copied (e.g. the disk of SOURCE_VM's clean snapshot), SOURCE_IP is the
# static address that disk boots with. SOURCE_VM must be shut off, and so
# must anything else at SOURCE_IP. Then takes the snapshot "lab_baseline" of
# both VMs: they belong together (the DC holds the client's machine account).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/env.sh"
src_vm=${1:?usage: build-win.sh SOURCE_VM SOURCE_DISK SOURCE_IP} src_disk=${2:?} src_ip=${3:?}
lab=$here/lab.sh
img=/var/lib/libvirt/images/$WIN_VM.qcow2
nvram=/var/lib/libvirt/qemu/nvram/${WIN_VM}_VARS.qcow2

virsh dominfo "$WIN_VM" >/dev/null 2>&1 && { echo "$WIN_VM already exists" >&2; exit 1; }
sudo qemu-img convert -U -O qcow2 "$src_disk" "$img"
src_nvram=$(virsh dumpxml --inactive "$src_vm" | sed -n "s|.*<nvram[^>]*>\(.*\)</nvram>.*|\1|p")
sudo cp "$src_nvram" "$nvram"

virsh dumpxml --inactive "$src_vm" | "$here/winxml.py" "$WIN_VM" "$WIN_MAC" "$img" "$nvram" > "/tmp/$WIN_VM.xml"
virsh define "/tmp/$WIN_VM.xml" && rm "/tmp/$WIN_VM.xml"

"$lab" start dc
"$lab" wait dc
"$lab" start win
win_at() {
    SSHPASS=$WIN_ADMIN_PASSWORD sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -o ConnectTimeout=5 "$WIN_ADMIN_USER@$1" "${@:2}"
}
until win_at "$src_ip" exit 2>/dev/null; do sleep 5; done

# The SSH session drops when the address changes: run it as a SYSTEM task
win_at "$src_ip" "
\$s = @'
Remove-NetRoute -InterfaceAlias Ethernet -DestinationPrefix 0.0.0.0/0 -Confirm:\$false -ErrorAction SilentlyContinue
Remove-NetIPAddress -InterfaceAlias Ethernet -AddressFamily IPv4 -Confirm:\$false
New-NetIPAddress -InterfaceAlias Ethernet -IPAddress $WIN_HOST -PrefixLength 24 -DefaultGateway $GATEWAY | Out-Null
Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses $DC_HOST
'@
Set-Content -Path C:\Windows\Temp\renet.ps1 -Value \$s
schtasks /create /tn renet /ru SYSTEM /sc once /st 00:00 /f /tr 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Windows\Temp\renet.ps1' 2>&1 | Out-Null
schtasks /run /tn renet | Out-Null
" || true
sleep 15
"$lab" wait win
"$lab" ssh win 'schtasks /delete /tn renet /f | Out-Null; Remove-Item C:\Windows\Temp\renet.ps1'

# Join with the new name; the password is read from stdin by PowerShell
printf '%s\n' "$DOMAIN_ADMIN_PASSWORD" | "$lab" ssh win "
\$pw = ConvertTo-SecureString ([Console]::In.ReadLine()) -AsPlainText -Force
\$c = New-Object System.Management.Automation.PSCredential('$DOMAIN_NETBIOS\\Administrator', \$pw)
Add-Computer -DomainName $DOMAIN_REALM -NewName $WIN_COMPUTER_NAME -Credential \$c -Force
Restart-Computer -Force"
sleep 30
"$lab" wait win
"$lab" ssh win 'nltest /sc_verify:'"$DOMAIN_REALM"' | Select -Last 2'

"$lab" stop win
"$lab" stop dc
"$lab" snapshot dc lab_baseline
"$lab" snapshot win lab_baseline
