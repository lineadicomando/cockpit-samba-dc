import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Modal, ModalVariant,
    ModalHeader, ModalBody, ModalFooter,
    Form, FormGroup, TextInput, Checkbox, ExpandableSection,
    Button, Alert,
    FormSelect, FormSelectOption,
    FormHelperText, HelperText, HelperTextItem,
} from "@patternfly/react-core";
import { createUser, getPasswordPolicy, addGroupMembers, setPrimaryGroup } from "../../lib/samba.ts";
import { usePasswordPolicy, usePasswordGenerator, useOus } from "../../lib/hooks.ts";
import { checkPasswordAgainstPolicy } from "../../lib/passwordUtils.ts";
import { validateUsername, usernameViolationMessage, validateEmail, emailViolationMessage } from "../../lib/validators.ts";
import { PasswordField, PasswordPolicyInfo, PasswordPolicyUnavailable } from "../PasswordField.tsx";
import { GroupMultiSelect } from "../GroupMultiSelect.tsx";
import { ContainerSelect, accountContainers } from "../ContainerSelect.tsx";
import { OrganizationFields } from "../OrganizationFields.tsx";

interface Props {
    onClose: () => void;
    onSuccess: () => void;
}

export function CreateUserModal({ onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [passwordConfirm, setPasswordConfirm] = useState("");
    const [givenName, setGivenName] = useState("");
    const [surname, setSurname] = useState("");
    const [email, setEmail] = useState("");
    const [mustChange, setMustChange] = useState(false);
    const [description, setDescription] = useState("");
    const [title, setTitle] = useState("");
    const [department, setDepartment] = useState("");
    const [company, setCompany] = useState("");
    const [moreOpen, setMoreOpen] = useState(false);
    const [groups, setGroups] = useState<string[]>([]);
    const [primaryGroup, setPrimaryGroupState] = useState("");
    const [ou, setOu] = useState("");
    const { ous } = useOus();
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const { policy, policyError } = usePasswordPolicy();
    const { generate, copyState, revealCount } = usePasswordGenerator(policy);

    function handleGroupsChange(v: string[]) {
        setGroups(v);
        if (primaryGroup && !v.includes(primaryGroup)) {
            setPrimaryGroupState("");
        }
    }

    function handleGenerate() {
        const pwd = generate();
        if (pwd === null) return;
        setPassword(pwd);
        setPasswordConfirm(pwd);
    }

    async function handleSubmit() {
        const usernameViolation = validateUsername(username.trim());
        if (usernameViolation) { setError(usernameViolationMessage(t, usernameViolation)); return; }
        if (!password) { setError(t("Password is required.")); return; }
        if (password !== passwordConfirm) { setError(t("Passwords do not match.")); return; }
        const emailViolation = validateEmail(email.trim());
        if (emailViolation) { setError(emailViolationMessage(t, emailViolation)); return; }
        setSubmitting(true);
        setError(null);
        const trimmed = username.trim();
        try {
            // Fall back to a fresh fetch so validation never gets skipped
            const pol = policy ?? await getPasswordPolicy();
            const violation = checkPasswordAgainstPolicy(pol, password);
            if (violation === "minLength") {
                setError(t("Password must be at least {{min}} characters.", { min: pol.minLength }));
                setSubmitting(false);
                return;
            }
            if (violation === "complexity") {
                setError(t("Password does not meet the complexity requirements."));
                setSubmitting(false);
                return;
            }
            await createUser(trimmed, password, {
                givenName: givenName.trim(), surname: surname.trim(), email: email.trim(),
                description: description.trim(), title: title.trim(), department: department.trim(),
                company: company.trim(), mustChangePassword: mustChange, ou,
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
            return;
        }
        try {
            if (groups.length > 0) {
                await Promise.all(groups.map(g => addGroupMembers(g, [trimmed])));
            }
            if (primaryGroup) {
                await setPrimaryGroup(trimmed, primaryGroup);
            }
        } catch (e) {
            // The account exists at this point: tell the user instead of
            // letting a resubmit fail with "user already exists".
            setError(t("User \"{{name}}\" was created, but group assignment failed: {{error}}", {
                name: trimmed,
                error: e instanceof Error ? e.message : String(e),
            }));
            setSubmitting(false);
            return;
        }
        setSubmitting(false);
        onSuccess();
    }

    return (
        <Modal
            variant={ModalVariant.small}
            isOpen
            onClose={onClose}
        >
            <ModalHeader title={t("Create user")} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                <Form>
                    <FormGroup label={t("Username")} isRequired fieldId="cu-username">
                        <TextInput id="cu-username" value={username} onChange={(_e, v) => setUsername(v)} isRequired />
                    </FormGroup>
                    <FormGroup label={t("Password")} isRequired fieldId="cu-password">
                        <PasswordField
                            id="cu-password"
                            label={t("Password")}
                            value={password}
                            onChange={setPassword}
                            isRequired
                            isDisabled={submitting}
                            forceReveal={revealCount}
                            onGenerate={policy ? handleGenerate : undefined}
                            copyState={copyState}
                        />
                        {policy ? <PasswordPolicyInfo policy={policy} /> : policyError && <PasswordPolicyUnavailable />}
                    </FormGroup>
                    <FormGroup label={t("Confirm password")} isRequired fieldId="cu-password-confirm">
                        <PasswordField
                            id="cu-password-confirm"
                            label={t("Confirm password")}
                            value={passwordConfirm}
                            onChange={setPasswordConfirm}
                            isRequired
                            isDisabled={submitting}
                            forceReveal={revealCount}
                        />
                    </FormGroup>
                    <FormGroup fieldId="cu-must-change">
                        <Checkbox id="cu-must-change"
                            label={t("Require password change at next login")}
                            isChecked={mustChange}
                            isDisabled={submitting}
                            onChange={(_e, checked) => setMustChange(checked)} />
                    </FormGroup>
                    <FormGroup label={t("Given name")} fieldId="cu-given-name">
                        <TextInput id="cu-given-name" value={givenName} onChange={(_e, v) => setGivenName(v)} placeholder={t("Optional")} />
                    </FormGroup>
                    <FormGroup label={t("Surname")} fieldId="cu-surname">
                        <TextInput id="cu-surname" value={surname} onChange={(_e, v) => setSurname(v)} placeholder={t("Optional")} />
                    </FormGroup>
                    <FormGroup label={t("Email")} fieldId="cu-email">
                        <TextInput id="cu-email" type="email" value={email} onChange={(_e, v) => setEmail(v)} placeholder={t("Optional")} />
                    </FormGroup>
                    <ExpandableSection toggleText={t("Description and organization")} isExpanded={moreOpen}
                        onToggle={(_e, open) => setMoreOpen(open)}>
                        <OrganizationFields idPrefix="cu" isDisabled={submitting}
                            values={{ description, title, department, company }}
                            onChange={{ description: setDescription, title: setTitle, department: setDepartment, company: setCompany }} />
                    </ExpandableSection>
                    <FormGroup label={t("Container")} fieldId="cu-ou">
                        <ContainerSelect id="cu-ou" value={ou} onChange={setOu}
                            choices={accountContainers(ous).filter(o => o.defaultFor !== "users")}
                            emptyLabel={t("Default (Users)")} isDisabled={submitting} />
                    </FormGroup>
                    <FormGroup label={t("Groups")} fieldId="cu-groups">
                        <GroupMultiSelect selected={groups} onChange={handleGroupsChange} isDisabled={submitting} />
                    </FormGroup>
                    <FormGroup label={t("Primary group")} fieldId="cu-primary-group">
                        <FormSelect
                            id="cu-primary-group"
                            value={primaryGroup}
                            onChange={(_e, v) => setPrimaryGroupState(v)}
                            isDisabled={submitting || groups.length === 0}
                        >
                            <FormSelectOption value="" label={t("Default (Domain Users)")} />
                            {groups.map(g => (
                                <FormSelectOption key={g} value={g} label={g} />
                            ))}
                        </FormSelect>
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>
                                    {t("Only groups added above can be set as primary.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
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
