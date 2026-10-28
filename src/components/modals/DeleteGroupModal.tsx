import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, TextInput,
    Button, Alert, List, ListItem,
} from "@patternfly/react-core";
import { deleteGroup } from "../../lib/samba.ts";
import type { Group } from "../../lib/types.ts";
import { SharesKeepingNotice } from "./SharesKeepingNotice.tsx";

const MAX_SHOWN = 5;

interface Props { group: Group; onClose: () => void; onSuccess: () => void; }

export function DeleteGroupModal({ group, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const shownMembers = group.members.slice(0, MAX_SHOWN);
    const hiddenCount = group.members.length - shownMembers.length;

    async function handleDelete() {
        if (confirm !== group.name) { setError(t("type_name_to_confirm_exact", { name: group.name })); return; }
        setSubmitting(true);
        setError(null);
        try { await deleteGroup(group.name); onSuccess(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); setSubmitting(false); }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Delete group: {{name}}", { name: group.name })} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {group.memberCount > 0 && (
                    <Alert
                        variant="warning"
                        isInline
                        title={t("group_members_warning", { count: group.memberCount })}
                        style={{ marginBottom: "1rem" }}
                    >
                        {group.members.length > 0 && (
                            <List>
                                {shownMembers.map(m => <ListItem key={m}>{m}</ListItem>)}
                                {hiddenCount > 0 && (
                                    <ListItem>{t("and_n_more", { count: hiddenCount })}</ListItem>
                                )}
                            </List>
                        )}
                    </Alert>
                )}
                <SharesKeepingNotice kind="group" names={[group.name]} />
                <Form>
                    <FormGroup label={t("type_name_to_confirm", { name: group.name })} isRequired fieldId="dg-confirm">
                        <TextInput id="dg-confirm" value={confirm} onChange={(_e, v) => setConfirm(v)} />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button key="delete" variant="danger" isLoading={submitting} isDisabled={confirm !== group.name} onClick={handleDelete}>{t("Delete")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
