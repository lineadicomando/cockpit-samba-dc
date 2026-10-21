#!/usr/bin/env bash
# Builds the test DC from scratch, from a shut-off Debian 13 VM with the
# QEMU guest agent and an admin account with sudo (DC_ADMIN_USER):
#   build-dc.sh BASE_VM
# Leaves the snapshots "baseline" (Debian with its own identity and address)
# and "samba_baseline" (domain provisioned, test users, module not installed).
# The base image's password of the admin account does not matter: it is set
# to DC_ADMIN_PASSWORD through the guest agent.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/env.sh"
base=${1:?usage: build-dc.sh BASE_VM}
lab=$here/lab.sh

virsh dominfo "$DC_VM" >/dev/null 2>&1 && { echo "$DC_VM already exists" >&2; exit 1; }
virt-clone --original "$base" --name "$DC_VM" --mac "$DC_MAC" \
    --file "/var/lib/libvirt/images/$DC_VM.qcow2"

"$lab" start dc
until virsh qemu-agent-command "$DC_VM" '{"execute":"guest-ping"}' >/dev/null 2>&1; do sleep 3; done
printf '%s:%s\n' "$DC_ADMIN_USER" "$DC_ADMIN_PASSWORD" |
    "$here/qga.py" "$DC_VM" --stdin /bin/sh -c "$(cat "$here/dc-base.sh")" dc-base.sh \
        dc "$DOMAIN_REALM" "$DC_HOST" "$GATEWAY"
"$here/qga.py" "$DC_VM" /bin/systemctl reboot || true   # the agent goes away mid-call
sleep 10
"$lab" wait dc
"$lab" stop dc
"$lab" snapshot dc baseline

"$lab" start dc
"$lab" wait dc
"$lab" root 'cat > /root/provision-dc.sh' < "$here/provision-dc.sh"
printf '%s\n%s\n' "$DOMAIN_ADMIN_PASSWORD" "$DOMAIN_TEST_PASSWORD" |
    "$lab" root "sh /root/provision-dc.sh $DOMAIN_REALM $DOMAIN_NETBIOS $GATEWAY && rm /root/provision-dc.sh"
"$lab" stop dc
"$lab" snapshot dc samba_baseline
