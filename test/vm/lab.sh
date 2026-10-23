#!/usr/bin/env bash
# Test VMs of cockpit-samba-dc: lifecycle, SSH and deploy. Settings come from
# .env (see .env.example). Targets: "dc" (the domain controller) or "win"
# (the Windows client).
#
#   lab.sh status                      VMs, state and snapshots
#   lab.sh resources dc win            would these fit on the host?
#   lab.sh start dc|win                start (refuses if the host is short)
#   lab.sh stop dc|win                 clean shutdown, waits until off
#   lab.sh snapshot dc|win NAME        snapshot of a shut-off VM
#   lab.sh revert dc|win NAME          revert a shut-off VM to NAME
#   lab.sh reset                       stop both, revert both to lab_baseline
#   lab.sh wait dc|win                 wait until SSH answers
#   lab.sh ssh dc|win [COMMAND]        SSH as the admin account (PowerShell on win)
#   lab.sh root COMMAND                COMMAND as root on the DC; stdin is passed on
#   lab.sh deploy                      build the Debian packages, install them on the DC
#   lab.sh tunnel [PORT]               Cockpit of the DC on http://127.0.0.1:PORT (9091)
#   lab.sh ansible PLAYBOOK [ARGS...]  ansible-playbook against the VMs (groups
#                                      samba_dc and windows), with the collection
#                                      of this working tree
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
export LC_ALL=C.UTF-8 # virsh and free are parsed below

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)

die() { echo "lab.sh: $*" >&2; exit 1; }

# target -> VM name, host, user, password
vm_of() {
    case $1 in
        dc) echo "$DC_VM" ;;
        win) echo "$WIN_VM" ;;
        *) die "unknown target '$1' (dc or win)" ;;
    esac
}
host_of() { case $1 in dc) echo "$DC_HOST" ;; win) echo "$WIN_HOST" ;; esac; }
user_of() { case $1 in dc) echo "$DC_ADMIN_USER" ;; win) echo "$WIN_ADMIN_USER" ;; esac; }
pass_of() { case $1 in dc) printf '%s' "$DC_ADMIN_PASSWORD" ;; win) printf '%s' "$WIN_ADMIN_PASSWORD" ;; esac; }

defined() { virsh dominfo "$1" >/dev/null 2>&1; }
state() { if defined "$1"; then virsh domstate "$1" | head -1; else echo "not defined"; fi; }
is_running() { [[ $(state "$1") == "running" ]]; }

mem_mib() { virsh dominfo "$1" | awk '/^Max memory:/ {print int($3/1024)}'; }
vcpus() { virsh dominfo "$1" | awk '/^CPU\(s\):/ {print $2}'; }

# Called in a condition, where "set -e" does not apply: check every step.
resources() {
    local need_mem=0 need_cpu=0 vm t
    for t in "$@"; do
        vm=$(vm_of "$t") || exit 1
        defined "$vm" || die "$vm is not defined"
        is_running "$vm" && continue
        need_mem=$((need_mem + $(mem_mib "$vm"))); need_cpu=$((need_cpu + $(vcpus "$vm")))
    done
    local run_cpu=0
    for vm in $(virsh list --name); do run_cpu=$((run_cpu + $(vcpus "$vm"))); done
    local avail; avail=$(free -m | awk '/^Mem:/ {print $7}')
    local cores; cores=$(nproc)
    echo "to start: ${need_mem} MiB, ${need_cpu} vCPU; host: ${avail} MiB available, $((run_cpu + need_cpu))/${cores} vCPU with the running VMs"
    (( need_mem <= avail - 1024 )) && (( run_cpu + need_cpu <= cores ))
}


wait_ssh() {
    local t=$1 i
    for i in $(seq 1 60); do
        SSHPASS=$(pass_of "$t") sshpass -e ssh "${SSH_OPTS[@]}" "$(user_of "$t")@$(host_of "$t")" exit 2>/dev/null && return 0
        sleep 5
    done
    die "no SSH answer from $t ($(host_of "$t")) after 5 minutes"
}

cmd=${1:-status}; shift || true
case $cmd in
    status)
        for vm in "$DC_VM" "$WIN_VM"; do
            printf '%-28s %s\n' "$vm" "$(state "$vm")"
            { virsh snapshot-list "$vm" --name 2>/dev/null || true; } | sed '/^$/d; s/^/    snapshot: /'
        done ;;
    resources)
        [[ $# -gt 0 ]] || set -- dc win
        resources "$@" && echo "ok" || { echo "does not fit"; exit 1; } ;;
    start)
        vm=$(vm_of "$1")
        is_running "$vm" && { echo "$vm already running"; exit 0; }
        resources "$1" || die "not enough resources on the host to start $vm"
        virsh start "$vm" ;;
    stop)
        vm=$(vm_of "$1")
        is_running "$vm" || { echo "$vm already off"; exit 0; }
        virsh shutdown "$vm" >/dev/null
        for _ in $(seq 1 60); do is_running "$vm" || { echo "$vm off"; exit 0; }; sleep 3; done
        die "$vm still running after 3 minutes (virsh destroy forces it off)" ;;
    snapshot)
        vm=$(vm_of "$1"); [[ -n ${2:-} ]] || die "snapshot needs a name"
        is_running "$vm" && die "shut $vm off first"
        virsh snapshot-create-as "$vm" "$2" ;;
    revert)
        vm=$(vm_of "$1"); [[ -n ${2:-} ]] || die "revert needs a snapshot name"
        is_running "$vm" && die "shut $vm off first"
        virsh snapshot-revert "$vm" "$2" ;;
    reset)
        # The two belong together: the DC holds the client's machine account
        for t in win dc; do "$0" stop "$t"; done
        for t in dc win; do virsh snapshot-revert "$(vm_of "$t")" lab_baseline; done
        echo "both VMs at lab_baseline, shut off" ;;
    wait)
        wait_ssh "$1" ;;
    ssh)
        t=$1; shift; vm_of "$t" >/dev/null
        SSHPASS=$(pass_of "$t") exec sshpass -e ssh "${SSH_OPTS[@]}" "$(user_of "$t")@$(host_of "$t")" "$@" ;;
    root)
        # sudo reads the password from the first line of stdin; the rest of
        # stdin reaches the command. When sudo asks none (NOPASSWD, as for
        # the browser tests), the shell drops that line instead, or it would
        # reach the command.
        [[ $# -gt 0 ]] || die "root needs a command"
        cmd=$(printf '%q' "$*")
        { printf '%s\n' "$DC_ADMIN_PASSWORD"; [[ -t 0 ]] || cat; } |
            SSHPASS=$DC_ADMIN_PASSWORD sshpass -e ssh "${SSH_OPTS[@]}" "$DC_ADMIN_USER@$DC_HOST" \
                "if sudo -n true 2>/dev/null; then IFS= read -r _; exec sudo -n sh -c $cmd; else exec sudo -S -p '' sh -c $cmd; fi" ;;
    deploy)
        # The Debian package, as an administrator would install it. Copies
        # left in a user's ~/.local (or under the pre-rename name) would
        # shadow it; a copy made by hand in /usr/share/cockpit/samba-dc is
        # removed by the package itself (debian/preinst).
        (cd "$VM_ROOT" && make --no-print-directory --silent deb >/dev/null) ||
            die "make deb failed: run it in $VM_ROOT to see why"
        # The two packages of the source, installed together: cockpit-samba-dc
        # depends on addcctl of the same version.
        debs=()
        for p in cockpit-samba-dc addcctl; do
            found=("$VM_ROOT"/build/${p}_*_all.deb)
            [[ ${#found[@]} -eq 1 && -f ${found[0]} ]] || die "expected one $p package in build/"
            debs+=("${found[0]##*/}")
        done
        echo "packages: ${debs[*]}"
        tar -C "$VM_ROOT/build" -cf - "${debs[@]}" | "$0" root 'set -e
            rm -rf /usr/share/cockpit/samba-ad-dc /home/*/.local/share/cockpit/samba-dc /home/*/.local/share/cockpit/samba-ad-dc
            dir=$(mktemp -d); trap "rm -rf $dir" EXIT
            tar -C "$dir" -xf -; chmod 755 "$dir"; chmod 644 "$dir"/*.deb
            DEBIAN_FRONTEND=noninteractive apt-get install -y -q --reinstall --allow-downgrades "$dir"/*.deb >/dev/null
            dpkg-query -W -f="installed: \${Package} \${Version}\n" cockpit-samba-dc addcctl
            sha256sum /usr/share/cockpit/samba-dc/index.js'
        sha256sum "$VM_ROOT/dist/index.js" | sed 's/^/local:  /'
        echo "reload the Cockpit page (F5) to load the new bundle" ;;
    ansible)
        # The inventory is written from .env; the passwords stay in the
        # environment, read by lookup('env'), never in the file.
        [[ $# -gt 0 ]] || die "ansible needs a playbook"
        tmp=$(umask 077; mktemp -d)
        trap 'rm -rf "$tmp"' EXIT
        mkdir -p "$tmp/ansible_collections/lineadicomando"
        ln -s "$VM_ROOT/ansible" "$tmp/ansible_collections/lineadicomando/samba_dc"
        domain=${DOMAIN_REALM,,}
        cat > "$tmp/hosts.yaml" <<INVENTORY
all:
  vars:
    ansible_ssh_common_args: "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
  children:
    samba_dc:
      hosts:
        dc:
          ansible_host: $DC_HOST
          ansible_user: $DC_ADMIN_USER
          ansible_password: "{{ lookup('env', 'DC_ADMIN_PASSWORD') }}"
          ansible_become_password: "{{ lookup('env', 'DC_ADMIN_PASSWORD') }}"
          samba_dc_build_realm: ${DOMAIN_REALM^^}
          samba_dc_build_domain: $DOMAIN_NETBIOS
          samba_dc_build_fqdn: ${DC_FQDN:-dc.$domain}
          samba_dc_build_search_domain: $domain
          samba_dc_build_nameserver: $GATEWAY
          samba_dc_build_address: $DC_HOST
          samba_dc_build_netmask: 255.255.255.0
          samba_dc_build_gateway: $GATEWAY
          samba_dc_build_ifname: ${DC_IFNAME:-enp1s0}
          samba_dc_build_ntp_server: $GATEWAY
          samba_dc_build_ntp_allow_network: ${DC_HOST%.*}.0/24
          samba_dc_build_administrator_passwd: "{{ lookup('env', 'DOMAIN_ADMIN_PASSWORD') }}"
    windows:
      hosts:
        win:
          ansible_host: $WIN_HOST
          ansible_user: $WIN_ADMIN_USER
          ansible_password: "{{ lookup('env', 'WIN_ADMIN_PASSWORD') }}"
          ansible_connection: ssh
          ansible_shell_type: powershell
          win_workman_domain_name: $domain
          win_workman_domain_admin_user: Administrator
          win_workman_domain_admin_password: "{{ lookup('env', 'DOMAIN_ADMIN_PASSWORD') }}"
          win_workman_domain_dns_servers: ["$DC_HOST"]
INVENTORY
        ANSIBLE_COLLECTIONS_PATH="$tmp:${ANSIBLE_COLLECTIONS_PATH:-$HOME/.ansible/collections:/usr/share/ansible/collections}" \
            ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -i "$tmp/hosts.yaml" "$@" ;;
    tunnel)
        port=${1:-9091}
        echo "Cockpit of the DC on http://127.0.0.1:$port (Ctrl-C to close)"
        SSHPASS=$DC_ADMIN_PASSWORD exec sshpass -e ssh "${SSH_OPTS[@]}" -N -L "$port:127.0.0.1:9090" "$DC_ADMIN_USER@$DC_HOST" ;;
    *)
        sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 1 ;;
esac
