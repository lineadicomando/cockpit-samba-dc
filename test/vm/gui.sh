# Drives the screen, keyboard and mouse of a VM from the host, with nothing
# installed in the guest. Source it:  . test/vm/gui.sh  (VM defaults to WIN_VM)
#
#   shot NAME          screenshot to $SHOTS/NAME.png (prints the path); also
#                      records the screen size used by the mouse functions
#   click X Y [BTN]    click at pixel X,Y of the last screenshot (left, right, middle)
#   dclick X Y         double click
#   move X Y           move the pointer
#   scroll N           wheel: N>0 down, N<0 up
#   key KEY...         keys pressed together, e.g. key KEY_LEFTMETA KEY_R
#   typ TEXT [--enter] type text (layout WIN_KEYMAP)
#   secret VAR [--enter]  type the value of VAR from .env, never shown
#   url ADDRESS NAME   open ADDRESS in the focused browser, then shot NAME
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
GUI_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VM=${VM:-$WIN_VM}
SHOTS=${SHOTS:-/tmp/vmshot}
mkdir -p "$SHOTS"
SCREEN_W=${SCREEN_W:-1280}; SCREEN_H=${SCREEN_H:-800}

shot() {
    # virsh picks the image format itself (PNG or PPM): let magick read it
    virsh screenshot "$VM" "$SHOTS/screen" >/dev/null || return 1
    magick "$SHOTS/screen" "$SHOTS/$1.png" || return 1
    read -r SCREEN_W SCREEN_H < <(magick identify -format '%w %h' "$SHOTS/$1.png")
    echo "$SHOTS/$1.png (${SCREEN_W}x${SCREEN_H})"
}
_qmp() { virsh qemu-monitor-command "$VM" "$1" >/dev/null; }
_events() { _qmp "{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[$1]}}"; }
# Absolute axes go from 0 to 32767 over the whole screen
move() {
    local x=$(( $1 * 32767 / SCREEN_W )) y=$(( $2 * 32767 / SCREEN_H ))
    _events "{\"type\":\"abs\",\"data\":{\"axis\":\"x\",\"value\":$x}},{\"type\":\"abs\",\"data\":{\"axis\":\"y\",\"value\":$y}}"
}
_btn() { _events "{\"type\":\"btn\",\"data\":{\"down\":$2,\"button\":\"$1\"}}"; }
click() { move "$1" "$2"; sleep 0.2; _btn "${3:-left}" true; sleep 0.1; _btn "${3:-left}" false; }
dclick() { click "$1" "$2"; sleep 0.1; _btn left true; sleep 0.05; _btn left false; }
scroll() {
    local n=$1 b=wheel-down i
    (( n < 0 )) && { b=wheel-up; n=$(( -n )); }
    for (( i = 0; i < n; i++ )); do _btn "$b" true; _btn "$b" false; done
}
key() { virsh send-key "$VM" "$@" >/dev/null; }
typ() { python3 "$GUI_DIR/type.py" "$VM" "$@"; }
secret() { python3 "$GUI_DIR/type.py" "$VM" --secret "$@"; }
# Del after typing drops Edge's completion from the history
url() { key KEY_LEFTCTRL KEY_L; sleep 0.5; typ "$1"; key KEY_DELETE; key KEY_ENTER; sleep "${3:-6}"; shot "$2"; }
