import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant, ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, TextInput,
    FormSelect, FormSelectOption,
    FormHelperText, HelperText, HelperTextItem,
    Button, Alert,
} from "@patternfly/react-core";
import { createGroup, type NewGroup } from "../../lib/samba.ts";
import {
    validateGroupName, groupNameViolationMessage, validateEmail, emailViolationMessage,
} from "../../lib/validators.ts";
import { useOus } from "../../lib/hooks.ts";
import { ContainerSelect, accountContainers } from "../ContainerSelect.tsx";

interface Props { onClose: () => void; onSuccess: () => void; }

type Scope = NonNullable<NewGroup["scope"]>;
type Category = NonNullable<NewGroup["category"]>;

export function CreateGroupModal({ onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [email, setEmail] = useState("");
    const [scope, setScope] = useState<Scope>("global");
    const [category, setCategory] = useState<Category>("security");
    const [ou, setOu] = useState("");
    const { ous } = useOus();
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function handleSubmit() {
        const violation = validateGroupName(name.trim());
        if (violation) { setError(groupNameViolationMessage(t, violation)); return; }
        const emailViolation = validateEmail(email.trim());
        if (emailViolation) { setError(emailViolationMessage(t, emailViolation)); return; }
        setSubmitting(true);
        setError(null);
        try {
            await createGroup(name.trim(), {
                description: description.trim(), email: email.trim(), scope, category, ou,
            });
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={onClose}>
            <ModalHeader title={t("Create group")} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form>
                    <FormGroup label={t("Group name")} isRequired fieldId="cg-name">
                        <TextInput id="cg-name" value={name} onChange={(_e, v) => setName(v)} isRequired />
                    </FormGroup>
                    <FormGroup label={t("Description")} fieldId="cg-description">
                        <TextInput id="cg-description" value={description} onChange={(_e, v) => setDescription(v)}
                            placeholder={t("Optional")} isDisabled={submitting} />
                    </FormGroup>
                    <FormGroup label={t("Email")} fieldId="cg-email">
                        <TextInput id="cg-email" type="email" value={email} onChange={(_e, v) => setEmail(v)}
                            placeholder={t("Optional")} isDisabled={submitting} />
                    </FormGroup>
                    <FormGroup label={t("Group scope")} fieldId="cg-scope">
                        <FormSelect id="cg-scope" value={scope} isDisabled={submitting}
                            onChange={(_e, v) => setScope(v as Scope)}>
                            <FormSelectOption value="global" label={t("Global")} />
                            <FormSelectOption value="domain" label={t("Domain local")} />
                            <FormSelectOption value="universal" label={t("Universal")} />
                        </FormSelect>
                    </FormGroup>
                    <FormGroup label={t("Group type")} fieldId="cg-category">
                        <FormSelect id="cg-category" value={category} isDisabled={submitting}
                            onChange={(_e, v) => setCategory(v as Category)}>
                            <FormSelectOption value="security" label={t("Security")} />
                            <FormSelectOption value="distribution" label={t("Distribution")} />
                        </FormSelect>
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>
                                    {t("Only security groups can be given access to shared folders.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    <FormGroup label={t("Container")} fieldId="cg-ou">
                        <ContainerSelect id="cg-ou" value={ou} onChange={setOu}
                            choices={accountContainers(ous).filter(o => o.defaultFor !== "users")}
                            emptyLabel={t("Default (Users)")} isDisabled={submitting} />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button key="create" variant="primary" isLoading={submitting} onClick={handleSubmit}>{t("Create")}</Button>
                <Button key="cancel" variant="link" onClick={onClose}>{t("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
}
