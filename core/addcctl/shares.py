# SPDX-License-Identifier: LGPL-2.1-or-later
"""Shared folders: registry shares under SHARES_DIR with a POSIX ACL.

Access is enforced twice: by the share ("valid users", plus "read list" for
read-only entries) and by a POSIX ACL on the folder tree, from which
acl_xattr derives the Windows ACL. A share never has an empty "valid users",
which would open it to every domain user.
"""
import os

from . import acl
from .drivemaps import DriveMaps, normalize_letter
from .errors import AddcError
from .smbconf import (SHARES_DIR, access_key, format_user_list, is_managed_path, parse_bool,
                      share_access, share_name_violation)


def check_registry_shares(dc):
    """smbd does not serve registry shares without "registry shares": net
    conf writes them all the same, and nothing would say they do not work."""
    if not dc.registry_shares:
        raise AddcError('smbd does not serve the shares addcctl creates: set "registry shares = yes" in the '
                        '[global] section of smb.conf and restart samba-ad-dc')


def check_principal_names(names):
    # A leading "-" would be read as an option by the tools these names reach
    for name in names:
        if not isinstance(name, str) or not name or name.startswith("-"):
            raise AddcError('Invalid account name: "%s"' % name)


class Shares:
    def __init__(self, dc, runner, shares_dir=SHARES_DIR):
        self.dc = dc
        self.runner = runner
        self.shares_dir = shares_dir.rstrip("/")
        self.drives = DriveMaps(dc, runner)

    # -- reading

    def _find(self, name):
        """(registry name, params) of a share, matched case-insensitively."""
        for section, params in self.dc.shares().items():
            if section.lower() == name.lower():
                return section, params
        return None, None

    def _known(self, shares):
        """{lowercased name} of the principals the shares list that exist in
        the directory, in one search."""
        names = {e["name"] for params in shares for e in share_access(params)}
        valid = [n for n in names if n and not n.startswith("-")]
        return set(self.dc.resolve_principals(sorted(valid))) if valid else set()

    def _describe(self, name, params, mappings, known=None):
        """A share; with known, the entries left by deleted accounts are
        marked "unknown"."""
        access = share_access(params)
        if known is not None:
            for entry in access:
                if entry["name"].lower() not in known:
                    entry["unknown"] = True
        return {
            "name": name,
            "path": params.get("path", ""),
            "comment": params.get("comment", ""),
            "browseable": parse_bool(params.get("browseable", params.get("browsable")), True),
            "access": access,
            "drive": mappings.get(name.lower()),
        }

    def _managed_shares(self):
        return [(name, params) for name, params in sorted(self.dc.shares().items(), key=lambda kv: kv[0].lower())
                if is_managed_path(params.get("path", ""), self.shares_dir)]

    def list(self):
        mappings = self.drives.mappings()
        shares = self._managed_shares()
        known = self._known([params for _, params in shares])
        return [self._describe(name, params, mappings, known) for name, params in shares]

    def get(self, name):
        section, params = self._find(name)
        if section is None or not is_managed_path(params.get("path", ""), self.shares_dir):
            raise AddcError('Shared folder "%s" not found' % name)
        return self._describe(section, params, self.drives.mappings(), self._known([params]))

    def listing(self, kind, name):
        """Names of the shares whose access list names this user or group."""
        return [section for section, params in self._managed_shares()
                if any(e["kind"] == kind and e["name"].lower() == name.lower() for e in share_access(params))]

    def _managed(self, name):
        """(section, params) of an existing share; fails on one outside
        shares_dir, which addcctl never changes."""
        section, params = self._find(name)
        if section is not None and not is_managed_path(params.get("path", ""), self.shares_dir):
            raise AddcError("Share %s exists with path %r, outside %s: it is not managed by addcctl"
                            % (section, params.get("path", ""), self.shares_dir))
        return section, params

    # -- principals and ACL

    def _resolve(self, access, kept=()):
        """Canonical names and kinds from the directory, with each SID.
        Entries named in kept (lowercased), already in the share, may name no
        account any more (left by a deleted one): they stay, marked
        "unknown", with no SID, until they are removed."""
        check_principal_names([e["name"] for e in access])
        found = self.dc.resolve_principals([e["name"] for e in access])
        unknown = [e["name"] for e in access if e["name"].lower() not in found and e["name"].lower() not in kept]
        if unknown:
            raise AddcError("Unknown user or group: %s" % ", ".join(unknown))
        resolved = []
        for entry in access:
            if entry["name"].lower() not in found:
                resolved.append({"name": entry["name"], "kind": entry.get("kind") or "user", "sid": None,
                                 "level": entry.get("level") or "read", "unknown": True})
                continue
            principal = found[entry["name"].lower()]
            if entry.get("kind") and entry["kind"] != principal["kind"]:
                raise AddcError("%s is a %s, not a %s" % (principal["name"], principal["kind"], entry["kind"]))
            resolved.append(dict(principal, level=entry.get("level") or "read"))
        return resolved

    def _grants(self, access):
        grants = []
        for entry in access:
            if entry.get("unknown"):
                continue
            ids = self.dc.posix_ids(entry["name"], entry.get("sid"))
            tag = "g" if entry["kind"] == "group" else "u"
            if tag not in ids:
                raise AddcError("%s %s\\%s cannot be resolved to a %s through winbind; check that winbind is "
                                "running" % (entry["kind"], self.dc.workgroup, entry["name"],
                                                                  "gid" if tag == "g" else "uid"))
            grants.append((tag, ids[tag], entry["level"]))
        return grants

    def _ensure_root(self, path):
        """Directory owned by root, mode 2770 (setgid keeps new files in the
        directory's group)."""
        try:
            st = os.stat(path)
        except OSError:
            st = None
        if st is not None and st.st_uid == 0 and st.st_gid == 0 and (st.st_mode & 0o7777) == 0o2770:
            return False
        if st is None:
            self.runner.change(["mkdir", "-p", "--", path])
        self.runner.change(["chown", "root:root", "--", path])
        self.runner.change(["chmod", "2770", "--", path])
        return True

    def _ensure_acl(self, path, access, old_access):
        """Rewrite the tree's ACL when the root's differs from the expected one.
        Only the root is compared: when it matches, the tree is taken to."""
        grants = self._grants(access)
        expected = acl.expected_acl(grants)
        current = set()
        if os.path.isdir(path):
            current = acl.parse_getfacl(self.runner.query(["getfacl", "-n", "-p", "-c", "-E", "--", path]))
        if current == expected:
            return False
        stale = acl.named_ids(current)
        for entry in list(access) + list(old_access):
            stale |= set(self.dc.posix_ids(entry["name"], entry.get("sid")).items())
        stale -= {(tag, posix_id) for tag, posix_id, _ in grants}
        self.runner.change(acl.setfacl_args(path, grants, stale))
        return True

    @staticmethod
    def _kept(access):
        return {e["name"].lower() for e in access if e.get("unknown")}

    @staticmethod
    def _entry(resolved):
        entry = {"name": resolved["name"], "kind": resolved["kind"], "level": resolved["level"]}
        if resolved.get("unknown"):
            entry["unknown"] = True
        return entry

    @staticmethod
    def _targets(resolved, drive):
        """The principals a drive mapping targets: those that exist. A mapping
        with no target would apply to every user."""
        targets = [e for e in resolved if not e.get("unknown")]
        if drive is not None and not targets:
            raise AddcError("A mapped drive needs at least one existing user or group: "
                            "add one, or remove the mapping")
        return targets

    # -- changing

    @staticmethod
    def _merge(current, requested, mode):
        if mode == "replace":
            merged = []
            for entry in requested:
                merged = [e for e in merged if e["name"].lower() != entry["name"].lower()] + [entry]
            return merged
        if mode == "remove":
            drop = {e["name"].lower() for e in requested}
            return [e for e in current if e["name"].lower() not in drop]
        merged = [dict(e) for e in current]
        for entry in requested:
            for e in merged:
                if e["name"].lower() == entry["name"].lower():
                    e["level"] = entry.get("level") or "read"
                    if entry.get("kind"):
                        e["kind"] = entry["kind"]
                    break
            else:
                merged.append(entry)
        return merged

    def set(self, request):
        """Create a share or bring it to the request. Keys left out keep the
        current value: access, comment, browseable, drive (null removes the
        mapping). Returns {changed, share, diff}."""
        name = request["name"]
        violation = share_name_violation(name)
        if violation:
            raise AddcError("Invalid share name %r: %s" % (name, violation))
        check_registry_shares(self.dc)
        section, params = self._managed(name)
        mappings = self.drives.mappings()
        before = self._describe(section, params, mappings, self._known([params])) if section else None

        name = section or name
        path = before["path"] if before else "%s/%s" % (self.shares_dir, name)
        current_access = before["access"] if before else []
        mode = request.get("access_mode", "replace")
        if "access" not in request:
            if before is None:
                raise AddcError("access is required to create share %s" % name)
            desired = current_access
        else:
            if before is None and mode == "remove":
                raise AddcError('Shared folder "%s" not found' % name)
            desired = self._merge(current_access, request["access"], mode)
        if not desired:
            # An empty "valid users" would open the share to every domain user
            raise AddcError("A shared folder needs at least one user or group")
        resolved = self._resolve(desired, self._kept(current_access))
        access = [self._entry(e) for e in resolved]

        # Checked before anything changes, so that a letter clash does not
        # leave a share created without its mapping.
        current_drive = before["drive"] if before else None
        if "drive" not in request:
            drive = current_drive
        elif request["drive"] is None:
            drive = None
        else:
            letter = normalize_letter(request["drive"].get("letter"))
            self.drives.check_letter(name, letter)
            label = request["drive"].get("label") or (current_drive or {}).get("label") or name
            drive = {"letter": letter, "label": label}

        targets = self._targets(resolved, drive)

        changed = self._ensure_root(path)
        changed = self._ensure_acl(path, resolved, current_access) or changed

        current_params = params if before else {}
        wanted = {}
        if before is None:
            wanted.update({"path": path, "read only": "no", "guest ok": "no"})
        if current_params.get("inherit acls") != "yes":
            wanted["inherit acls"] = "yes"
        remove = []
        if before is None or access_key(access) != access_key(current_access):
            readers = [e for e in access if e["level"] == "read"]
            wanted["valid users"] = format_user_list(access, self.dc.workgroup)
            if readers:
                wanted["read list"] = format_user_list(readers, self.dc.workgroup)
            elif "read list" in current_params:
                remove.append("read list")
        comment = before["comment"] if before else ""
        if "comment" in request:
            comment = request["comment"] or ""
            if comment and current_params.get("comment") != comment:
                wanted["comment"] = comment
            elif not comment and "comment" in current_params:
                remove.append("comment")
        browseable = before["browseable"] if before else True
        if "browseable" in request:
            browseable = bool(request["browseable"])
        if "browseable" not in current_params or parse_bool(current_params.get("browseable"), True) != browseable:
            wanted["browseable"] = "yes" if browseable else "no"
        if wanted or remove:
            self.dc.update_share(name, wanted, remove, create=before is None)
            changed = True

        # Also when only the access list changed: the mapping targets it
        if drive is not None or current_drive is not None:
            changed = self.drives.set(name, targets, drive) or changed

        after = {"name": name, "path": path, "comment": comment, "browseable": browseable,
                 "access": access, "drive": drive}
        return {"changed": changed, "share": after,
                "diff": {"before": before, "after": after}}

    def delete(self, request):
        """Remove a share and its mapping; the folder too with delete_data."""
        name = request["name"]
        section, params = self._managed(name)
        if section is None:
            return {"changed": False, "diff": {"before": None, "after": None}}
        before = self._describe(section, params, self.drives.mappings())
        if before["drive"]:
            self.drives.set(section, [], None)
        self.dc.delete_share(section)
        if request.get("delete_data") and os.path.exists(before["path"]):
            self.runner.change(["rm", "-rf", "--one-file-system", "--", before["path"]])
        return {"changed": True, "diff": {"before": before, "after": None}}

    def rename_principal(self, request):
        """After a user or group is renamed: smb.conf names principals, so
        each share listing the old name gets the new one. The POSIX ACL keeps
        uid/gid, which follow the SID; the drive mapping is rewritten for the
        names next to the SIDs."""
        kind, old, new = request["kind"], request["old"], request["new"]
        check_principal_names([old, new])
        renamed = []
        if old == new:
            return {"changed": False, "shares": renamed}
        mappings = self.drives.mappings()
        shares = self._managed_shares()
        known = self._known([params for _, params in shares])
        for section, params in shares:
            share = self._describe(section, params, mappings, known)
            hit = [a for a in share["access"] if a["kind"] == kind and a["name"].lower() == old.lower()]
            if not hit:
                continue
            access = [{"name": new, "kind": a["kind"], "level": a["level"]} if a in hit else a
                      for a in share["access"]]
            readers = [e for e in access if e["level"] == "read"]
            wanted = {"valid users": format_user_list(access, self.dc.workgroup)}
            if readers:
                wanted["read list"] = format_user_list(readers, self.dc.workgroup)
            self.dc.update_share(section, wanted)
            if share["drive"]:
                resolved = self._resolve(access, self._kept(access))
                self.drives.set(section, self._targets(resolved, share["drive"]), share["drive"])
            renamed.append(section)
        return {"changed": bool(renamed), "shares": renamed}
