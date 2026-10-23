// The Ansible collection in ansible/ has the version of the project: `make
// release` writes it into ansible/galaxy.yml, and into the release of the
// Cockpit page that samba_dc_build installs by default, so that a collection
// and the DC software it installs match.

export const GALAXY = "ansible/galaxy.yml";
export const COCKPIT_DEFAULTS = "ansible/roles/samba_dc_build/defaults/main.yaml";

const GALAXY_VERSION = /^version:[ \t]*"?([^"\s]*)"?[ \t]*$/m;
const COCKPIT_VERSION = /^samba_dc_build_cockpit_version:[ \t]*"?([^"\s]*)"?[ \t]*$/m;

function read(text, re, what) {
    const m = re.exec(text);
    if (!m) throw new Error(`${what} has no version line`);
    return m[1];
}

function write(text, re, line, what) {
    if (!re.test(text)) throw new Error(`${what} has no version line`);
    return text.replace(re, line);
}

export function galaxyVersion(text) {
    return read(text, GALAXY_VERSION, GALAXY);
}

export function setGalaxyVersion(text, version) {
    return write(text, GALAXY_VERSION, `version: ${version}`, GALAXY);
}

export function cockpitVersion(text) {
    return read(text, COCKPIT_VERSION, COCKPIT_DEFAULTS);
}

export function setCockpitVersion(text, version) {
    return write(text, COCKPIT_VERSION, `samba_dc_build_cockpit_version: "${version}"`, COCKPIT_DEFAULTS);
}
