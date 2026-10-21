#!/bin/sh
# Run as root on the DC (build-dc.sh copies and starts it): installs Samba
# and Cockpit and provisions a new AD domain, then adds the test accounts.
#   provision-dc.sh REALM NETBIOS FORWARDER
# stdin: the domain Administrator password, then the test users' password,
# one per line.
set -eu
realm=$1 netbios=$2 forwarder=$3
read -r admin_pw
read -r test_pw
REALM=$(echo "$realm" | tr a-z A-Z)

export DEBIAN_FRONTEND=noninteractive
echo "krb5-config krb5-config/default_realm string $REALM" | debconf-set-selections
apt-get update -q
# No recommends: they would pull NetworkManager and PackageKit into Cockpit
apt-get install -y -q --no-install-recommends \
    samba samba-ad-dc samba-ad-provision winbind libnss-winbind libpam-winbind krb5-user smbclient \
    ldb-tools acl attr python3-setproctitle cockpit

# An AD DC runs everything in the "samba" service
systemctl disable --now smbd nmbd winbind 2>/dev/null || true
systemctl mask smbd nmbd winbind
systemctl unmask samba-ad-dc
# Only for building a DC from scratch: a failed earlier run may have left a
# half-provisioned database behind.
rm -f /etc/samba/smb.conf
rm -rf /var/lib/samba/private/* /var/lib/samba/sysvol/*

# Provision with a random password, then set the real one over stdin, so it
# never appears in a command line.
tmp_pw="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')aA1!"
samba-tool domain provision --realm="$REALM" --domain="$netbios" \
    --server-role=dc --dns-backend=SAMBA_INTERNAL \
    --option="dns forwarder = $forwarder" --option="registry shares = yes" \
    --adminpass="$tmp_pw" >/dev/null
cp /var/lib/samba/private/krb5.conf /etc/krb5.conf
systemctl enable --now samba-ad-dc
printf 'search %s\nnameserver 127.0.0.1\n' "$realm" > /etc/resolv.conf

# Domain users visible to the system (getent, chown), as the module expects
sed -i -E '/^(passwd|group):/ { /winbind/! s/$/ winbind/ }' /etc/nsswitch.conf

for _ in $(seq 1 30); do samba-tool user list >/dev/null 2>&1 && break; sleep 2; done
printf '%s\n%s\n' "$admin_pw" "$admin_pw" | samba-tool user setpassword Administrator >/dev/null 2>&1
# Test passwords must not expire under a test that runs months later
samba-tool domain passwordsettings set --max-pwd-age=0 >/dev/null

# Fixtures of the baseline: two groups and three users
samba-tool group add Teachers >/dev/null
samba-tool group add Students >/dev/null
for u in teacher1:Teachers student1:Students student2:Students; do
    name=${u%%:*} group=${u#*:}
    printf '%s\n%s\n' "$test_pw" "$test_pw" | samba-tool user add "$name" >/dev/null 2>&1
    samba-tool group addmembers "$group" "$name" >/dev/null
done

echo "provisioned $REALM ($netbios)"
samba-tool domain info 127.0.0.1 | sed -n '/Domain/p;/DC name/p'
