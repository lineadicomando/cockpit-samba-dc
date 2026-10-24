# shellcheck shell=bash
# Sourced by the scripts in this directory: lab.conf, then .env from the
# repository root (not tracked; see .env.example), then .env.<host name> if
# there is one. Values of the .env files are taken verbatim (no quotes, no
# expansion), so passwords may contain any character but a newline.
VM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VM_ROOT=$(cd "$VM_DIR/../.." && pwd)
# shellcheck source=lab.conf
. "$VM_DIR/lab.conf"
if [[ ! -f $VM_ROOT/.env ]]; then
    echo "missing $VM_ROOT/.env: copy .env.example and fill it in" >&2
    return 1 2>/dev/null || exit 1
fi
for _env in "$VM_ROOT/.env" "$VM_ROOT/.env.$(hostname -s)"; do
    [[ -f $_env ]] || continue
    while IFS= read -r line || [[ -n $line ]]; do
        [[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] && export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
    done < "$_env"
done
unset _env line
# Derived, unless an .env file sets them
export GATEWAY=${GATEWAY:-$LAB_SUBNET.1}
export DC_HOST=${DC_HOST:-$LAB_SUBNET.$DC_IP_HOST}
export WIN_HOST=${WIN_HOST:-$LAB_SUBNET.$WIN_IP_HOST}
export DC_VM DC_MAC DC_ADMIN_USER DOMAIN_REALM DOMAIN_NETBIOS WIN_VM WIN_MAC WIN_COMPUTER_NAME WIN_ADMIN_USER WIN_KEYMAP
export LIBVIRT_DEFAULT_URI=${LIBVIRT_DEFAULT_URI:-qemu:///system}
