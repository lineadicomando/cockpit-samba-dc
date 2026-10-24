#!/bin/sh
# Run as root on the DC just installed from the netinst image (build-dc.sh):
# lays out the network the way samba_dc_build writes it, which the Debian
# installer does not. The static stanza moves from /etc/network/interfaces
# to interfaces.d/<interface> (two stanzas for one interface collide at the
# next ifup), and /etc/resolv.conf names a nameserver.
#   dc-base.sh ADDRESS GATEWAY DNS_DOMAIN
set -eu
addr=$1 gw=$2 domain=$3

iface=$(ip -o route show default | awk '{print $5; exit}')
[ -n "$iface" ] || { echo "dc-base.sh: no default route" >&2; exit 1; }

mkdir -p /etc/network/interfaces.d
cat > "/etc/network/interfaces.d/$iface" <<EOS
iface $iface inet static
    address $addr
    netmask 255.255.255.0
    gateway $gw
    dns-nameservers $gw
    dns-search $domain
EOS
cat > /etc/network/interfaces <<EOS
source /etc/network/interfaces.d/*

auto lo
iface lo inet loopback

allow-hotplug $iface
EOS
printf 'search %s\nnameserver %s\n' "$domain" "$gw" > /etc/resolv.conf
echo "network: $iface $addr, gateway and DNS $gw"
