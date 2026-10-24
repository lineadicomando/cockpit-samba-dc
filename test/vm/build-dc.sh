#!/usr/bin/env bash
# Builds the test DC from scratch, with no manual step:
#   build-dc.sh            (lab.sh build dc)
# Debian 13 from the installer of the mirror (or DEBIAN_ISO) driven by
# preseed.cfg, on the lab's own network (lab.sh net); dc-base.sh lays out the
# network as samba_dc_build writes it. Snapshot "baseline". Then
# provision-dc.sh: Samba, Cockpit, the domain and its test accounts, snapshot
# "samba_baseline". Leaves the VM shut off. About 15 minutes.
# What fails where: the installer shows on the VM's screen (virt-viewer).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
lab=$VM_DIR/lab.sh
die() { echo "build-dc.sh: $*" >&2; exit 1; }

for v in DC_ADMIN_PASSWORD DOMAIN_ADMIN_PASSWORD DOMAIN_TEST_PASSWORD; do
    [[ -n ${!v:-} ]] || die "$v is not set in .env"
done
virsh dominfo "$DC_VM" >/dev/null 2>&1 && die "$DC_VM already exists: lab.sh rebuild dc"
"$lab" net
"$lab" resources dc || die "not enough resources on the host to build $DC_VM"

if [[ -n ${DEBIAN_ISO:-} ]]; then
    [[ -f $DEBIAN_ISO ]] || die "DEBIAN_ISO: no such file $DEBIAN_ISO"
    location=$DEBIAN_ISO
else
    location=$DEBIAN_LOCATION
fi

# The preseed holds the password's hash only; it is built in a private
# directory, never in the work tree (which may be synced elsewhere).
tmp=$(umask 077; mktemp -d)
trap 'rm -rf "$tmp"' EXIT
PASSWORD_HASH=$(printf '%s' "$DC_ADMIN_PASSWORD" | openssl passwd -6 -stdin)
DNS_DOMAIN=${DOMAIN_REALM,,}
export PASSWORD_HASH DNS_DOMAIN DC_HOST GATEWAY DC_NAME DC_LOCALE DC_KEYMAP DEBIAN_MIRROR LAB_TIMEZONE DC_ADMIN_USER
"$VM_DIR/render.py" "$VM_DIR/preseed.cfg" > "$tmp/preseed.cfg"
unset PASSWORD_HASH

echo "$DC_VM: installing Debian from $location"
virt-install --name "$DC_VM" --osinfo debian13 \
    --memory "$DC_MEM_MIB" --vcpus "$DC_VCPUS" --cpu host-passthrough --machine q35 \
    --disk "pool=$LAB_POOL,size=$DC_DISK_GIB,format=qcow2,bus=virtio" \
    --location "$location" \
    --initrd-inject "$tmp/preseed.cfg" --extra-args "auto=true priority=critical" \
    --network "network=$LAB_NET,mac=$DC_MAC,model=virtio" \
    --channel unix,target.type=virtio,target.name=org.qemu.guest_agent.0 \
    --graphics spice --noautoconsole --noreboot --wait 60 >/dev/null ||
    die "the installation did not finish in 60 minutes: look at the VM's screen"
rm -rf "$tmp"
# An ISO given as the location stays attached as a CD-ROM: eject it, or
# the snapshots would keep pointing at it.
for dev in $(virsh domblklist "$DC_VM" --details | awk '$2 == "cdrom" && $4 != "-" {print $3}'); do
    virsh change-media "$DC_VM" "$dev" --eject --config >/dev/null
done

virsh start "$DC_VM" >/dev/null
"$lab" wait dc
"$lab" root "sh -s $DC_HOST $GATEWAY ${DOMAIN_REALM,,}" < "$VM_DIR/dc-base.sh"
"$lab" root 'systemctl reboot' </dev/null || true
sleep 15
"$lab" wait dc
"$lab" root "ip -4 -o addr show | grep -q ' $DC_HOST/'" </dev/null || die "$DC_VM did not come back at $DC_HOST"
release=$("$lab" root '. /etc/os-release; echo "$PRETTY_NAME, Debian $(cat /etc/debian_version)"' </dev/null)
"$lab" stop dc
virsh snapshot-create-as "$DC_VM" baseline \
    --description "$release, $DC_ADMIN_USER with sudo, static $DC_HOST; built by test/vm/build-dc.sh" >/dev/null
echo "$DC_VM: snapshot baseline ($release)"

"$lab" start dc >/dev/null
"$lab" wait dc
"$lab" root 'cat > /root/provision-dc.sh' < "$VM_DIR/provision-dc.sh"
printf '%s\n%s\n' "$DOMAIN_ADMIN_PASSWORD" "$DOMAIN_TEST_PASSWORD" |
    "$lab" root "sh /root/provision-dc.sh $DOMAIN_REALM $DOMAIN_NETBIOS $GATEWAY && rm /root/provision-dc.sh"
"$lab" stop dc
virsh snapshot-create-as "$DC_VM" samba_baseline \
    --description "domain ${DOMAIN_REALM^^} provisioned, test accounts, module not installed; built by test/vm/build-dc.sh" >/dev/null
echo "$DC_VM built: snapshots baseline and samba_baseline, shut off"
