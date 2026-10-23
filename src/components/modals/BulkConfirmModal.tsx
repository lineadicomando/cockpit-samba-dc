import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, List, ListItem,
    Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant,
} from "@patternfly/react-core";
import { enableUser, disableUser, unlockUser, deleteUser, provisionHomeDir } from "../../lib/samba.ts";
import type { User } from "../../lib/types.ts";
import { mapLimit, BULK_CONCURRENCY } from "../../lib/concurrency.ts";

export type BulkConfirmAction = "enable" | "disable" | "unlock" | "delete" | "provision-home";

interface Props {
    action: BulkConfirmAction;
    users: User[];
    onClose: () => void;
    onSuccess: () => void;
}

type Results = {
    succeeded: string[];
    failed: Array<{ username: string; error: string }>;
};

function partitionUsers(action: BulkConfirmAction, users: User[]): [User[], User[]] {
    let actionable: User[];
    switch (action) {
        case "enable":         actionable = users.filter(u => u.status !== "Active"   && !u.isStatusLocked); break;
        case "disable":        actionable = users.filter(u => u.status !== "Disabled" && !u.isStatusLocked); break;
        case "unlock":         actionable = users.filter(u => u.lockedOut); break;
        case "delete":         actionable = users.filter(u => !u.isProtected); break;
        case "provision-home": actionable = users.filter(u => !u.homeDirectory && !u.isProtected); break;
    }
    const names = new Set(actionable.map(u => u.username));
    return [actionable, users.filter(u => !names.has(u.username))];
}

export function BulkConfirmModal({ action, users, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [actionable, skipped] = partitionUsers(action, users);
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<Results | null>(null);

    // Use switch/case with literal keys so i18next-parser can detect them statically
    function modalTitle(): string {
        switch (action) {
            case "enable":         return t("Enable users");
            case "disable":        return t("Disable users");
            case "unlock":         return t("Unlock users");
            case "delete":         return t("Delete users");
            case "provision-home": return t("Provision home directory");
        }
    }
    function actionVerb(): string {
        switch (action) {
            case "enable":         return t("Enable");
            case "disable":        return t("Disable");
            case "unlock":         return t("Unlock");
            case "delete":         return t("Delete");
            case "provision-home": return t("Provision");
        }
    }
    function successTitle(count: number): string {
        switch (action) {
            case "enable":         return t("users_enabled", { count });
            case "disable":        return t("users_disabled", { count });
            case "unlock":         return t("users_unlocked", { count });
            case "delete":         return t("users_deleted", { count });
            case "provision-home": return t("users_provisioned", { count });
        }
    }
    function willBeText(count: number): string {
        switch (action) {
            case "enable":         return t("users_will_be_enabled", { count });
            case "disable":        return t("users_will_be_disabled", { count });
            case "unlock":         return t("users_will_be_unlocked", { count });
            case "delete":         return t("users_will_be_deleted", { count });
            case "provision-home": return t("users_will_be_provisioned", { count });
        }
    }
    const isDanger = action === "delete";

    async function handleConfirm() {
        setRunning(true);
        const settled = await mapLimit(actionable, BULK_CONCURRENCY, async u => {
            try {
                if (action === "enable") await enableUser(u.username);
                else if (action === "disable") await disableUser(u.username);
                else if (action === "unlock") await unlockUser(u.username);
                else if (action === "delete") await deleteUser(u.username);
                else await provisionHomeDir(u.username);
                return { username: u.username, ok: true, error: "" };
            } catch (e) {
                return { username: u.username, ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        });
        setRunning(false);
        const succeeded = settled.filter(r => r.ok).map(r => r.username);
        const failed = settled.filter(r => !r.ok).map(r => ({ username: r.username, error: r.error }));
        if (failed.length === 0) { onSuccess(); return; }
        setResults({ succeeded, failed });
    }

    function handleClose() {
        if (results && results.succeeded.length > 0) onSuccess();
        else onClose();
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={handleClose}>
            <ModalHeader title={modalTitle()} />
            <ModalBody>
                {results ? (
                    <>
                        {results.succeeded.length > 0 && (
                            <Alert variant="success" isInline
                                title={successTitle(results.succeeded.length)}
                                style={{ marginBottom: "1rem" }}
                            />
                        )}
                        {results.failed.map(f => (
                            <Alert key={f.username} variant="danger" isInline
                                title={t("{{name}}: failed", { name: f.username })}
                                style={{ marginBottom: "0.5rem" }}
                            >
                                {f.error}
                            </Alert>
                        ))}
                    </>
                ) : actionable.length === 0 ? (
                    <Alert variant="info" isInline title={t("No users to process")}>
                        {t("All selected users are already in the target state or are protected.")}
                    </Alert>
                ) : (
                    <>
                        {isDanger && (
                            <Alert variant="warning" isInline title={t("This action cannot be undone.")}
                                style={{ marginBottom: "1rem" }}
                            />
                        )}
                        <p style={{ marginBottom: "0.5rem" }}>
                            {willBeText(actionable.length)}
                        </p>
                        <List style={{ maxHeight: "220px", overflowY: "auto", marginBottom: skipped.length ? "1rem" : 0 }}>
                            {actionable.map(u => (
                                <ListItem key={u.username}>
                                    <strong>{u.username}</strong>{u.fullName ? ` — ${u.fullName}` : ""}
                                </ListItem>
                            ))}
                        </List>
                        {skipped.length > 0 && (
                            <Alert variant="info" isInline
                                title={t("users_will_skip", { count: skipped.length })}
                            >
                                {skipped.map(u => u.username).join(", ")} {t("— already in target state or protected.")}
                            </Alert>
                        )}
                    </>
                )}
            </ModalBody>
            <ModalFooter>
                {!results && (
                    <Button
                        variant={isDanger ? "danger" : "primary"}
                        isLoading={running}
                        isDisabled={running || actionable.length === 0}
                        onClick={handleConfirm}
                    >
                        {actionVerb()}
                    </Button>
                )}
                <Button variant="link" isDisabled={running} onClick={handleClose}>
                    {results ? t("Close") : t("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
