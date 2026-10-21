# Sourced by the scripts in this directory: loads .env from the repository
# root and exports its variables. Values are taken verbatim (no quotes, no
# expansion), so passwords may contain any character but a newline.
VM_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ ! -f $VM_ROOT/.env ]]; then
    echo "missing $VM_ROOT/.env: copy .env.example and fill it in" >&2
    return 1 2>/dev/null || exit 1
fi
while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] && export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done < "$VM_ROOT/.env"
export LIBVIRT_DEFAULT_URI=${LIBVIRT_DEFAULT_URI:-qemu:///system}
