import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, Checkbox, List, ListItem,
    Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant,
} from "@patternfly/react-core";
import { deleteOu } from "../../lib/samba.ts";
import type { Ou } from "../../lib/types.ts";

// What is in the OU and below it, as the lists show it
export interface OuContents {
    ous: string[];
    users: string[];
    groups: string[];
    computers: string[];
}

interface Props {
    ou: Ou;
    contents: OuContents;
    onClose: () => void;
    onSuccess: () => void;
}

export function DeleteOuModal({ ou, contents, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [confirmed, setConfirmed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const accounts = [...contents.users, ...contents.groups, ...contents.computers.map(c => c + "$")];
    const empty = accounts.length === 0 && contents.ous.length === 0;

    async function handleDelete() {
        setSubmitting(true);
        setError(null);
        try {
            // An OU that looks empty is deleted without recursive: if something
            // the lists do not show is in it, addcctl refuses
            await deleteOu(ou.dn, !empty);
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Delete OU: {{name}}", { name: ou.path })} titleIconVariant="warning" />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {empty ? (
                    <p>{t("The OU is empty.")}</p>
                ) : (
                    <>
                        <Alert variant="danger" isInline style={{ marginBottom: "1rem" }}
                            title={t("Everything in this OU is deleted with it. This cannot be undone.")}>
                            {t("Home directories and the entries of shared folders stay, as when an account is deleted.")}
                        </Alert>
                        <List style={{ marginBottom: "1rem" }}>
                            {contents.ous.length > 0 && <ListItem>{t("ous_count", { count: contents.ous.length })}</ListItem>}
                            {contents.users.length > 0 && <ListItem>{t("users_count", { count: contents.users.length })}</ListItem>}
                            {contents.groups.length > 0 && <ListItem>{t("groups_count", { count: contents.groups.length })}</ListItem>}
                            {contents.computers.length > 0 && <ListItem>{t("computers_count", { count: contents.computers.length })}</ListItem>}
                        </List>
                        {accounts.length > 0 && (
                            <p style={{ maxHeight: "160px", overflowY: "auto", marginBottom: "1rem" }}>
                                {accounts.join(", ")}
                            </p>
                        )}
                        <Checkbox id="dou-confirm" isChecked={confirmed} onChange={(_e, v) => setConfirmed(v)}
                            label={t("Delete the OU and everything in it")} isDisabled={submitting} />
                    </>
                )}
            </ModalBody>
            <ModalFooter>
                <Button variant="danger" isLoading={submitting} isDisabled={submitting || (!empty && !confirmed)}
                    onClick={handleDelete}>
                    {t("Delete")}
                </Button>
                <Button variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
