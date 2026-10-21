#!/bin/sh
# Run as root in a fresh clone of the Debian base image, through the guest
# agent (build-dc.sh): gives the clone its own identity and address.
#   dc-base.sh HOSTNAME DOMAIN ADDRESS GATEWAY
# The password of the admin account, "user:password", comes on stdin.
set -eu
host=$1 domain=$2 addr=$3 gw=$4

chpasswd

# Own machine-id and SSH host keys (the clone has the base image's)
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup >/dev/null
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A >/dev/null

hostnamectl set-hostname "$host"
sed -i "/127.0.1.1/d" /etc/hosts
printf '%s\t%s.%s %s\n' "$addr" "$host" "$domain" "$host" >> /etc/hosts

# Static address in interfaces.d, the main file's stanza commented out: the
# layout the Samba provisioning expects (one stanza per interface).
iface=$(ip -o route show default | awk '{print $5; exit}')
sed -i "/^iface $iface inet/,/^\$/ s/^/#/" /etc/network/interfaces
cat > "/etc/network/interfaces.d/$iface" <<EOS
auto $iface
iface $iface inet static
	address $addr/24
	gateway $gw
EOS
# Until the DC serves DNS itself, resolve through the libvirt gateway
printf 'search %s\nnameserver %s\n' "$domain" "$gw" > /etc/resolv.conf
