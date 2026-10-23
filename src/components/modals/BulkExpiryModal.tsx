import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, Form, List, ListItem,
    Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant,
} from "@patternfly/react-core";
import { setAccountExpiry } from "../../lib/samba.ts";
import type { User } from "../../lib/types.ts";
import { mapLimit, BULK_CONCURRENCY } from "../../lib/concurrency.ts";
import { AccountExpiryField, expiryFromValue, expiryValueError, type ExpiryValue } from "../AccountExpiryField.tsx";

interface Props {
    users: User[];
    onClose: () => void;
    onSuccess: () => void;
}

type Failure = { username: string; error: string };

// Sets one expiry date (or "never") on every selected account except the
// system ones, whose expiry could lock the domain's administrators out.
export function BulkExpiryModal({ users, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const actionable = users.filter(u => !u.isProtected);
    const skipped = users.filter(u => u.isProtected);
    const [value, setValue] = useState<ExpiryValue>({ never: false, day: "" });
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<{ succeeded: number; failed: Failure[] } | null>(null);

    async function handleConfirm() {
        const invalid = expiryValueError(t, value);
        if (invalid) { setError(invalid); return; }
        const instant = expiryFromValue(value);
        if (instant === undefined) return;
        setError(null);
        setRunning(true);
        const settled = await mapLimit(actionable, BULK_CONCURRENCY, async u => {
            try {
                await setAccountExpiry(u.username, instant);
                return { username: u.username, error: null };
            } catch (e) {
                return { username: u.username, error: e instanceof Error ? e.message : String(e) };
            }
        });
        setRunning(false);
        const failed = settled.filter((r): r is Failure => r.error !== null);
        if (failed.length === 0) { onSuccess(); return; }
        setResults({ succeeded: settled.length - failed.length, failed });
    }

    function handleClose() {
        if (results && results.succeeded > 0) onSuccess();
        else onClose();
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={handleClose}>
            <ModalHeader title={t("Set account expiry")} />
            <ModalBody>
                {results ? (
                    <>
                        {results.succeeded > 0 && (
                            <Alert variant="success" isInline style={{ marginBottom: "1rem" }}
                                title={t("users_expiry_set", { count: results.succeeded })} />
                        )}
                        {results.failed.map(f => (
                            <Alert key={f.username} variant="danger" isInline style={{ marginBottom: "0.5rem" }}
                                title={t("{{name}}: failed", { name: f.username })}>
                                {f.error}
                            </Alert>
                        ))}
                    </>
                ) : actionable.length === 0 ? (
                    <Alert variant="info" isInline title={t("No users to process")}>
                        {t("System accounts cannot be given an expiry date.")}
                    </Alert>
                ) : (
                    <>
                        {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                        <Form style={{ marginBottom: "1rem" }} onSubmit={e => e.preventDefault()}>
                            <AccountExpiryField id="bulk-expiry" value={value} isDisabled={running}
                                onChange={v => { setValue(v); setError(null); }}
                                appendTo={() => document.body} />
                        </Form>
                        <p style={{ marginBottom: "0.5rem" }}>{t("users_will_get_expiry", { count: actionable.length })}</p>
                        <List style={{ maxHeight: "220px", overflowY: "auto", marginBottom: skipped.length ? "1rem" : 0 }}>
                            {actionable.map(u => (
                                <ListItem key={u.username}>
                                    <strong>{u.username}</strong>{u.fullName ? ` — ${u.fullName}` : ""}
                                </ListItem>
                            ))}
                        </List>
                        {skipped.length > 0 && (
                            <Alert variant="info" isInline title={t("users_will_skip", { count: skipped.length })}>
                                {skipped.map(u => u.username).join(", ")} {t("— system accounts.")}
                            </Alert>
                        )}
                    </>
                )}
            </ModalBody>
            <ModalFooter>
                {!results && (
                    <Button variant="primary" isLoading={running}
                        isDisabled={running || actionable.length === 0} onClick={handleConfirm}>
                        {t("Set expiry")}
                    </Button>
                )}
                <Button variant="link" isDisabled={running} onClick={handleClose}>
                    {results ? t("Close") : t("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
