import React, { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
    Breadcrumb, BreadcrumbItem,
    PageBreadcrumb, PageSection,
    Title, Spinner, Alert,
    Card, CardTitle, CardBody,
    Form, FormGroup, FormHelperText, HelperText, HelperTextItem,
    TextInput, Checkbox,
    FormSelect, FormSelectOption,
    ActionGroup, Button,
    Divider,
    Label, LabelGroup,
    EmptyState, EmptyStateBody,
} from "@patternfly/react-core";
import { Table, Thead, Tbody, Tr, Th, Td } from "@patternfly/react-table";
import { UserIcon, UsersIcon } from "@patternfly/react-icons";
import cockpit from "cockpit";
import { getUserDetails, listGroups, refreshUser, unlockUser, setAccountExpiry, modifyUser, setUserPassword, getUserPasswordPolicy, addGroupMembers, removeGroupMembers, setPrimaryGroup as savePrimaryGroup, provisionHomeDir } from "../lib/samba.ts";
import { listShares, effectiveShareAccess, expandNestedGroups } from "../lib/shares.ts";
import type { User } from "../lib/types.ts";
import { usePasswordPolicy, usePasswordGenerator, useSingleLoad } from "../lib/hooks.ts";
import { checkPasswordAgainstPolicy } from "../lib/passwordUtils.ts";
import { validateUsername, usernameViolationMessage } from "../lib/validators.ts";
import { PasswordField, PasswordPolicyInfo, PasswordPolicyUnavailable } from "./PasswordField.tsx";
import { GroupMultiSelect } from "./GroupMultiSelect.tsx";
import { UserStatusLabels } from "./UserStatusLabels.tsx";
import { AccountExpiryField, expiryValueOf, expiryFromValue, expiryValueError, formatExpiry, type ExpiryValue } from "./AccountExpiryField.tsx";
import { ContainerLabel } from "./ContainerSelect.tsx";

interface Props {
    username: string;
}

export function UserDetailPage({ username }: Props) {
    const { t } = useTranslation();
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        getUserDetails(username)
            .then(u => { if (cancelled) return; setUser(u); setLoading(false); })
            .catch(e => { if (cancelled) return; setLoadError(e instanceof Error ? e.message : String(e)); setLoading(false); });
        return () => { cancelled = true; };
    }, [username]);

    function goBack() { cockpit.location.go("/"); }

    return (
        <>
            <PageBreadcrumb hasBodyWrapper={false}>
                <Breadcrumb>
                    <BreadcrumbItem onClick={goBack} style={{ cursor: "pointer" }}>{t("Users")}</BreadcrumbItem>
                    <BreadcrumbItem isActive>{username}</BreadcrumbItem>
                </Breadcrumb>
            </PageBreadcrumb>

            <PageSection hasBodyWrapper={false}>
                <Title headingLevel="h1">{user?.fullName || username}</Title>
            </PageSection>

            {loading && (
                <PageSection hasBodyWrapper={false}>
                    <Spinner aria-label={t("Loading user")} />
                </PageSection>
            )}

            {loadError && (
                <PageSection hasBodyWrapper={false}>
                    <Alert variant="danger" isInline title={t("Failed to load user")}>{loadError}</Alert>
                </PageSection>
            )}

            {!loading && !loadError && user && (
                <>
                    <PageSection hasBodyWrapper={false}>
                        <IdentitySection user={user} onUpdate={setUser} />
                    </PageSection>
                    <Divider />
                    <PageSection hasBodyWrapper={false}>
                        <GroupsSection user={user} onUpdate={setUser} />
                    </PageSection>
                    <Divider />
                    <PageSection hasBodyWrapper={false}>
                        <AccountSection user={user} onUpdate={setUser} />
                    </PageSection>
                    <Divider />
                    <PageSection hasBodyWrapper={false}>
                        <AuthenticationSection username={user.username} />
                    </PageSection>
                    <Divider />
                    <PageSection hasBodyWrapper={false}>
                        <HomeDirSection user={user} onUpdate={setUser} />
                    </PageSection>
                    <Divider />
                    <PageSection hasBodyWrapper={false}>
                        <SharedFoldersSection user={user} />
                    </PageSection>
                </>
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// Identity section
// ---------------------------------------------------------------------------
function IdentitySection({ user, onUpdate }: { user: User; onUpdate: (u: User) => void }) {
    const { t } = useTranslation();
    const [newUsername, setNewUsername] = useState(user.username);
    const [givenName, setGivenName] = useState(user.givenName);
    const [surname, setSurname] = useState(user.surname);
    const [email, setEmail] = useState(user.email);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    const unchanged =
        newUsername === user.username &&
        givenName === user.givenName &&
        surname === user.surname &&
        email === user.email;

    async function handleSave() {
        const violation = validateUsername(newUsername.trim());
        if (violation) { setError(usernameViolationMessage(t, violation)); return; }
        if (unchanged) return;
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            await modifyUser(user.username, { givenName, surname, email, newUsername: newUsername.trim() });
            if (newUsername.trim() !== user.username) {
                cockpit.location.go(newUsername.trim());
            } else {
                const updated = await refreshUser(user.username);
                onUpdate(updated);
                setSuccess(true);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Card isPlain>
            <CardTitle><Title headingLevel="h2" size="xl">{t("Identity")}</Title></CardTitle>
            <CardBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {success && <Alert variant="success" isInline title={t("Changes saved.")} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <FormGroup label={t("Username")} fieldId="ud-username" isRequired>
                        <TextInput id="ud-username" value={newUsername}
                            onChange={(_e, v) => { setNewUsername(v); setSuccess(false); }}
                            isDisabled={user.isProtected} />
                        {user.isProtected && (
                            <FormHelperText>
                                <HelperText>
                                    <HelperTextItem>{t("System accounts cannot be renamed.")}</HelperTextItem>
                                </HelperText>
                            </FormHelperText>
                        )}
                    </FormGroup>
                    <FormGroup label={t("Given name")} fieldId="ud-given-name">
                        <TextInput id="ud-given-name" value={givenName}
                            onChange={(_e, v) => { setGivenName(v); setSuccess(false); }} />
                    </FormGroup>
                    <FormGroup label={t("Surname")} fieldId="ud-surname">
                        <TextInput id="ud-surname" value={surname}
                            onChange={(_e, v) => { setSurname(v); setSuccess(false); }} />
                    </FormGroup>
                    <FormGroup label={t("Email")} fieldId="ud-email">
                        <TextInput id="ud-email" type="email" value={email}
                            onChange={(_e, v) => { setEmail(v); setSuccess(false); }} />
                    </FormGroup>
                    <ActionGroup>
                        <Button variant="primary" isLoading={saving}
                            isDisabled={unchanged || saving} onClick={handleSave}>
                            {t("Save changes")}
                        </Button>
                    </ActionGroup>
                </Form>
            </CardBody>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Account section: status, lockout and expiry
// ---------------------------------------------------------------------------
function AccountSection({ user, onUpdate }: { user: User; onUpdate: (u: User) => void }) {
    const { t } = useTranslation();
    const [expiry, setExpiry] = useState<ExpiryValue>(() => expiryValueOf(user.accountExpires));
    const [busy, setBusy] = useState<"unlock" | "expiry" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const saved = expiryValueOf(user.accountExpires);
    const unchanged = expiry.never === saved.never && (expiry.never || expiry.day === saved.day);

    async function run(kind: "unlock" | "expiry", action: () => Promise<void>, message: string) {
        setBusy(kind);
        setError(null);
        setSuccess(null);
        try {
            await action();
            const updated = await refreshUser(user.username);
            onUpdate(updated);
            setExpiry(expiryValueOf(updated.accountExpires));
            setSuccess(message);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    }

    function handleSaveExpiry() {
        const invalid = expiryValueError(t, expiry);
        if (invalid) { setError(invalid); return; }
        const instant = expiryFromValue(expiry);
        if (instant === undefined) return;
        run("expiry", () => setAccountExpiry(user.username, instant), t("Account expiry saved."));
    }

    return (
        <Card isPlain>
            <CardTitle><Title headingLevel="h2" size="xl">{t("Account")}</Title></CardTitle>
            <CardBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {success && <Alert variant="success" isInline title={success} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <FormGroup label={t("Status")} fieldId="ud-status">
                        <UserStatusLabels user={user} />
                        {user.accountExpires !== null && (
                            <FormHelperText>
                                <HelperText>
                                    <HelperTextItem>
                                        {user.expired
                                            ? t("Expired on {{date}}.", { date: formatExpiry(user.accountExpires) })
                                            : t("Expires on {{date}}.", { date: formatExpiry(user.accountExpires) })}
                                    </HelperTextItem>
                                </HelperText>
                            </FormHelperText>
                        )}
                    </FormGroup>
                    <FormGroup label={t("Container")} fieldId="ud-container">
                        <ContainerLabel dn={user.container} />
                    </FormGroup>
                    {user.lockedOut && (
                        <FormGroup fieldId="ud-unlock">
                            <Alert variant="warning" isInline isPlain
                                title={t("The account is locked out after too many failed logon attempts.")} />
                            <Button variant="secondary" isLoading={busy === "unlock"} isDisabled={busy !== null}
                                onClick={() => run("unlock", () => unlockUser(user.username), t("Account unlocked."))}
                                style={{ marginTop: "0.5rem" }}>
                                {t("Unlock")}
                            </Button>
                        </FormGroup>
                    )}
                    <AccountExpiryField id="ud-expiry" value={expiry}
                        onChange={v => { setExpiry(v); setError(null); setSuccess(null); }}
                        isDisabled={busy !== null || user.isProtected} />
                    {user.isProtected && (
                        <HelperText>
                            <HelperTextItem>{t("System accounts cannot be given an expiry date.")}</HelperTextItem>
                        </HelperText>
                    )}
                    {!user.isProtected && (
                        <ActionGroup>
                            <Button variant="primary" isLoading={busy === "expiry"}
                                isDisabled={unchanged || busy !== null} onClick={handleSaveExpiry}>
                                {t("Save expiry")}
                            </Button>
                        </ActionGroup>
                    )}
                </Form>
            </CardBody>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Groups section
// ---------------------------------------------------------------------------
function GroupsSection({ user, onUpdate }: { user: User; onUpdate: (u: User) => void }) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState<string[]>(user.groups);
    const [primaryGroup, setPrimaryGroupState] = useState(user.primaryGroup);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    const membershipUnchanged = selected.length === user.groups.length &&
        selected.every(g => user.groups.includes(g));
    const unchanged = membershipUnchanged && primaryGroup === user.primaryGroup;

    function handleMembershipChange(v: string[]) {
        // Prevent removing the current primary group without changing it first
        if (primaryGroup && !v.includes(primaryGroup)) {
            setError(t("cannot_remove_primary_group", { name: primaryGroup }));
            return;
        }
        setError(null);
        setSelected(v);
        setSuccess(false);
    }

    async function handleSave() {
        if (unchanged) return;
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            const toAdd = selected.filter(g => !user.groups.includes(g));
            const toRemove = user.groups.filter(g => !selected.includes(g));

            // 1. Add new group members first (required before setting a new group as primary)
            if (toAdd.length > 0) {
                await Promise.all(toAdd.map(g => addGroupMembers(g, [user.username])));
            }
            // 2. Change primary group if needed (user is now a member of the new group)
            if (primaryGroup !== user.primaryGroup) {
                await savePrimaryGroup(user.username, primaryGroup);
            }
            // 3. Remove old group members (safe now that primary has been updated)
            if (toRemove.length > 0) {
                await Promise.all(toRemove.map(g => removeGroupMembers(g, [user.username])));
            }

            const updated = await refreshUser(user.username);
            onUpdate(updated);
            setSelected(updated.groups);
            setPrimaryGroupState(updated.primaryGroup);
            setSuccess(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Card isPlain>
            <CardTitle><Title headingLevel="h2" size="xl">{t("Groups")}</Title></CardTitle>
            <CardBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {success && <Alert variant="success" isInline title={t("Group membership updated.")} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <FormGroup label={t("Member of")} fieldId="ud-groups">
                        <GroupMultiSelect
                            selected={selected}
                            onChange={handleMembershipChange}
                            isDisabled={saving}
                        />
                    </FormGroup>
                    <FormGroup label={t("Primary group")} fieldId="ud-primary-group">
                        <FormSelect
                            id="ud-primary-group"
                            value={primaryGroup}
                            onChange={(_e, v) => { setPrimaryGroupState(v); setError(null); setSuccess(false); }}
                            isDisabled={saving || selected.length === 0}
                        >
                            {selected.map(g => (
                                <FormSelectOption key={g} value={g} label={g} />
                            ))}
                        </FormSelect>
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>
                                    {t("Only groups the user is a member of can be set as primary.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    <ActionGroup>
                        <Button variant="primary" isLoading={saving}
                            isDisabled={unchanged || saving} onClick={handleSave}>
                            {t("Save changes")}
                        </Button>
                    </ActionGroup>
                </Form>
            </CardBody>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Home directory section
// ---------------------------------------------------------------------------
function HomeDirSection({ user, onUpdate }: { user: User; onUpdate: (u: User) => void }) {
    const { t } = useTranslation();
    const [provisioning, setProvisioning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    const isProvisioned = !!user.homeDirectory;

    async function handleProvision() {
        setProvisioning(true);
        setError(null);
        setSuccess(false);
        try {
            await provisionHomeDir(user.username);
            const updated = await refreshUser(user.username);
            onUpdate(updated);
            setSuccess(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setProvisioning(false);
        }
    }

    return (
        <Card isPlain>
            <CardTitle><Title headingLevel="h2" size="xl">{t("Home Directory")}</Title></CardTitle>
            <CardBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {success && <Alert variant="success" isInline title={t("Home directory provisioned.")} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <FormGroup label={t("Drive")} fieldId="ud-home-drive">
                        <TextInput id="ud-home-drive" value={user.homeDrive || "—"} isDisabled />
                    </FormGroup>
                    <FormGroup label={t("Path")} fieldId="ud-home-path">
                        <TextInput id="ud-home-path" value={user.homeDirectory || "—"} isDisabled />
                    </FormGroup>
                    {!isProvisioned && !user.isProtected && (
                        <ActionGroup>
                            <Button variant="primary" isLoading={provisioning}
                                isDisabled={provisioning} onClick={handleProvision}>
                                {t("Provision home directory")}
                            </Button>
                        </ActionGroup>
                    )}
                </Form>
            </CardBody>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Shared folders section (read-only: access is edited on the share)
// ---------------------------------------------------------------------------
function SharedFoldersSection({ user }: { user: User }) {
    const { t } = useTranslation();
    const { items: shares, loading: sharesLoading, error: sharesError } = useSingleLoad(listShares);
    const { items: allGroups, loading: groupsLoading, error: groupsError } = useSingleLoad(listGroups);
    const loading = sharesLoading || groupsLoading;
    const error = sharesError ?? groupsError;

    // Recomputed from user.groups, so it follows edits in the Groups section
    const groups = useMemo(() => expandNestedGroups(user.groups, allGroups), [user.groups, allGroups]);
    const rows = shares
        .map(share => ({ share, access: effectiveShareAccess(share, user.username, groups) }))
        .filter(r => r.access !== null)
        .sort((a, b) => a.share.name.localeCompare(b.share.name));

    return (
        <Card isPlain>
            <CardTitle><Title headingLevel="h2" size="xl">{t("Shared folders")}</Title></CardTitle>
            <CardBody>
                {error && <Alert variant="danger" isInline title={t("Failed to load shared folders")}>{error}</Alert>}
                {loading && <Spinner size="md" aria-label={t("Loading shared folders")} />}
                {!loading && !error && rows.length === 0 && (
                    <EmptyState variant="xs" titleText={t("No shared folders")} headingLevel="h4">
                        <EmptyStateBody>{t("This user has no access to any shared folder.")}</EmptyStateBody>
                    </EmptyState>
                )}
                {!loading && rows.length > 0 && (
                    <Table aria-label={t("Shared folders table")} variant="compact">
                        <Thead>
                            <Tr>
                                <Th>{t("Name")}</Th>
                                <Th>{t("Permissions")}</Th>
                                <Th>{t("Granted through")}</Th>
                                <Th>{t("Drive")}</Th>
                            </Tr>
                        </Thead>
                        <Tbody>
                            {rows.map(({ share, access }) => (
                                <Tr key={share.name}>
                                    <Td dataLabel={t("Name")}>{share.name}</Td>
                                    <Td dataLabel={t("Permissions")}>
                                        {access!.level === "write"
                                            ? <Label color="blue">{t("Read and write")}</Label>
                                            : <Label color="grey">{t("Read only")}</Label>}
                                    </Td>
                                    <Td dataLabel={t("Granted through")}>
                                        <LabelGroup>
                                            {access!.via.map(a => (
                                                <Label key={`${a.kind}:${a.name}`} isCompact variant="outline"
                                                    icon={a.kind === "group" ? <UsersIcon /> : <UserIcon />}>
                                                    {a.name}
                                                </Label>
                                            ))}
                                        </LabelGroup>
                                    </Td>
                                    <Td dataLabel={t("Drive")}>
                                        {share.automount ? `${share.automount.letter}: ${share.automount.label}` : "—"}
                                    </Td>
                                </Tr>
                            ))}
                        </Tbody>
                    </Table>
                )}
            </CardBody>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Authentication section
// ---------------------------------------------------------------------------
function AuthenticationSection({ username }: { username: string }) {
    const { t } = useTranslation();
    const [password, setPassword] = useState("");
    const [passwordConfirm, setPasswordConfirm] = useState("");
    const [mustChange, setMustChange] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const { policy, pso, policyError } = usePasswordPolicy(username);
    const { generate, copyState, revealCount } = usePasswordGenerator(policy);

    function handleGenerate() {
        const pwd = generate();
        if (pwd === null) return;
        setPassword(pwd);
        setPasswordConfirm(pwd);
        setSuccess(false);
    }

    async function handleSave() {
        if (!password) { setError(t("New password is required.")); return; }
        if (password !== passwordConfirm) { setError(t("Passwords do not match.")); return; }
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            // Fall back to a fresh fetch so validation never gets skipped
            const pol = policy ?? (await getUserPasswordPolicy(username)).policy;
            const violation = checkPasswordAgainstPolicy(pol, password);
            if (violation === "minLength") {
                setError(t("Password must be at least {{min}} characters.", { min: pol.minLength }));
                return;
            }
            if (violation === "complexity") {
                setError(t("Password does not meet the complexity requirements."));
                return;
            }
            await setUserPassword(username, password, mustChange);
            setPassword("");
            setPasswordConfirm("");
            setMustChange(true);
            setSuccess(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Card isPlain>
            <CardTitle><Title headingLevel="h2" size="xl">{t("Authentication")}</Title></CardTitle>
            <CardBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {success && <Alert variant="success" isInline title={t("Password updated.")} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <FormGroup label={t("New password")} fieldId="ud-password">
                        <PasswordField
                            id="ud-password"
                            value={password}
                            onChange={v => { setPassword(v); setSuccess(false); }}
                            isDisabled={saving}
                            forceReveal={revealCount}
                            onGenerate={policy ? handleGenerate : undefined}
                            copyState={copyState}
                        />
                        {policy ? <PasswordPolicyInfo policy={policy} pso={pso} /> : policyError && <PasswordPolicyUnavailable />}
                    </FormGroup>
                    <FormGroup label={t("Confirm password")} fieldId="ud-password-confirm">
                        <PasswordField
                            id="ud-password-confirm"
                            value={passwordConfirm}
                            onChange={v => { setPasswordConfirm(v); setSuccess(false); }}
                            isDisabled={saving}
                            forceReveal={revealCount}
                        />
                    </FormGroup>
                    <FormGroup fieldId="ud-must-change">
                        <Checkbox id="ud-must-change"
                            label={t("Require password change at next login")}
                            isChecked={mustChange}
                            onChange={(_e, checked) => setMustChange(checked)} />
                    </FormGroup>
                    <ActionGroup>
                        <Button variant="primary" isLoading={saving}
                            isDisabled={saving || (!password && !passwordConfirm)} onClick={handleSave}>
                            {t("Set password")}
                        </Button>
                    </ActionGroup>
                </Form>
            </CardBody>
        </Card>
    );
}
