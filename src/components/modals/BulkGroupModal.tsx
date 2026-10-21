import React, { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, List, ListItem,
    MenuToggle, Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant,
    SearchInput, Select, SelectList, SelectOption, Spinner,
} from "@patternfly/react-core";
import { addGroupMembers, removeGroupMembers, setPrimaryGroup } from "../../lib/samba.ts";
import { useGroupNames } from "../../lib/hooks.ts";
import type { User } from "../../lib/types.ts";
import { mapLimit, BULK_CONCURRENCY } from "../../lib/concurrency.ts";

export type BulkGroupAction = "add-group" | "remove-group" | "change-primary-group";

interface Props {
    action: BulkGroupAction;
    users: User[];
    onClose: () => void;
    onSuccess: () => void;
}

type Status =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "error"; message: string }
    | { kind: "partial"; succeeded: string[]; failed: Array<{ username: string; error: string }> };

function groupIntersection(users: User[]): string[] {
    if (users.length === 0) return [];
    return users
        .reduce<string[]>((acc, u) => acc.filter(g => u.groups.includes(g)), [...users[0].groups])
        .sort((a, b) => a.localeCompare(b));
}

export function BulkGroupModal({ action, users, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    // Adding offers every group; removing / changing primary only the groups
    // all selected users share.
    const isAdd = action === "add-group";
    const { groupNames, loading: loadingGroups, error: groupLoadError } = useGroupNames(isAdd);
    const commonGroups = useMemo(() => groupIntersection(users), [users]);
    const availableGroups = isAdd ? groupNames : commonGroups;
    const [selectedGroup, setSelectedGroup] = useState("");
    const [groupSearch, setGroupSearch] = useState("");
    const [groupSelectOpen, setGroupSelectOpen] = useState(false);
    const [status, setStatus] = useState<Status>({ kind: "idle" });

    const META: Record<BulkGroupAction, { title: string; verb: string; label: string }> = {
        "add-group":            { title: t("Add users to group"),      verb: t("Add"),   label: t("Group to add") },
        "remove-group":         { title: t("Remove users from group"), verb: t("Remove"), label: t("Group to remove") },
        "change-primary-group": { title: t("Change primary group"),    verb: t("Apply"), label: t("New primary group") },
    };
    const meta = META[action];


    const filteredGroups = availableGroups.filter(g =>
        g.toLowerCase().includes(groupSearch.toLowerCase())
    );

    const noCommonGroups = !isAdd && availableGroups.length === 0;
    const isRunning = status.kind === "running";
    const isDone = status.kind === "error" || status.kind === "partial";

    async function handleConfirm() {
        if (!selectedGroup) return;
        setStatus({ kind: "running" });
        try {
            if (action === "add-group") {
                await addGroupMembers(selectedGroup, users.map(u => u.username));
                onSuccess();
                return;
            }
            if (action === "remove-group") {
                await removeGroupMembers(selectedGroup, users.map(u => u.username));
                onSuccess();
                return;
            }
            // change-primary-group: per-user
            const settled = await mapLimit(users, BULK_CONCURRENCY, async u => {
                try {
                    await setPrimaryGroup(u.username, selectedGroup);
                    return { username: u.username, ok: true, error: "" };
                } catch (e) {
                    return { username: u.username, ok: false, error: e instanceof Error ? e.message : String(e) };
                }
            });
            const succeeded = settled.filter(r => r.ok).map(r => r.username);
            const failed = settled.filter(r => !r.ok).map(r => ({ username: r.username, error: r.error }));
            if (failed.length === 0) { onSuccess(); return; }
            setStatus({ kind: "partial", succeeded, failed });
        } catch (e) {
            setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
    }

    function handleClose() {
        if (status.kind === "partial" && status.succeeded.length > 0) onSuccess();
        else onClose();
    }

    return (
        <Modal variant={ModalVariant.medium} isOpen onClose={handleClose}>
            <ModalHeader title={meta.title} />
            <ModalBody>
                {status.kind === "error" && (
                    <Alert variant="danger" isInline title={t("Operation failed")} style={{ marginBottom: "1rem" }}>
                        {status.message}
                    </Alert>
                )}
                {status.kind === "partial" && (
                    <>
                        {status.succeeded.length > 0 && (
                            <Alert variant="success" isInline
                                title={t("users_updated", { count: status.succeeded.length })}
                                style={{ marginBottom: "1rem" }}
                            />
                        )}
                        {status.failed.map(f => (
                            <Alert key={f.username} variant="danger" isInline
                                title={t("{{name}}: failed", { name: f.username })}
                                style={{ marginBottom: "0.5rem" }}
                            >
                                {f.error}
                            </Alert>
                        ))}
                    </>
                )}
                {!isDone && (
                    <>
                        <p style={{ marginBottom: "0.5rem" }}>
                            {t("users_applies_to", { count: users.length })}
                        </p>
                        <List style={{ maxHeight: "150px", overflowY: "auto", marginBottom: "1.25rem" }}>
                            {users.map(u => (
                                <ListItem key={u.username}>
                                    <strong>{u.username}</strong>{u.fullName ? ` — ${u.fullName}` : ""}
                                </ListItem>
                            ))}
                        </List>
                        {groupLoadError && (
                            <Alert variant="danger" isInline title={t("Failed to load groups")}
                                style={{ marginBottom: "1rem" }}
                            >
                                {groupLoadError}
                            </Alert>
                        )}
                        {noCommonGroups ? (
                            <Alert variant="warning" isInline title={t("No groups in common")}>
                                {t("The selected users share no common group memberships. Select users with at least one group in common.")}
                            </Alert>
                        ) : loadingGroups ? (
                            <Spinner size="sm" aria-label={t("Loading groups")} />
                        ) : (
                            <>
                                <p style={{ marginBottom: "0.25rem" }}><strong>{meta.label}</strong></p>
                                <Select
                                    isOpen={groupSelectOpen}
                                    onOpenChange={isOpen => { setGroupSelectOpen(isOpen); if (!isOpen) setGroupSearch(""); }}
                                    onSelect={(_evt, val) => { setSelectedGroup(val as string); setGroupSelectOpen(false); }}
                                    selected={selectedGroup || undefined}
                                    toggle={ref => (
                                        <MenuToggle
                                            ref={ref}
                                            onClick={() => setGroupSelectOpen(o => !o)}
                                            isExpanded={groupSelectOpen}
                                            isDisabled={isRunning}
                                            style={{ width: "100%" }}
                                        >
                                            {selectedGroup || t("Select a group…")}
                                        </MenuToggle>
                                    )}
                                >
                                    <div style={{ padding: "4px 8px" }}>
                                        <SearchInput
                                            value={groupSearch}
                                            onChange={(_e, val) => setGroupSearch(val)}
                                            onClear={() => setGroupSearch("")}
                                            placeholder={t("Filter groups…")}
                                            onClick={e => e.stopPropagation()}
                                        />
                                    </div>
                                    <SelectList style={{ maxHeight: "200px", overflowY: "auto" }}>
                                        {filteredGroups.length > 0
                                            ? filteredGroups.map(g => (
                                                <SelectOption key={g} value={g}>{g}</SelectOption>
                                            ))
                                            : <SelectOption isDisabled value="">{t("No groups found")}</SelectOption>
                                        }
                                    </SelectList>
                                </Select>
                            </>
                        )}
                    </>
                )}
            </ModalBody>
            <ModalFooter>
                {!isDone && (
                    <Button
                        variant="primary"
                        isLoading={isRunning}
                        isDisabled={isRunning || !selectedGroup || noCommonGroups || !!groupLoadError}
                        onClick={handleConfirm}
                    >
                        {meta.verb}
                    </Button>
                )}
                <Button variant="link" isDisabled={isRunning} onClick={handleClose}>
                    {isDone ? t("Close") : t("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
