import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import cockpit from "cockpit";
import {
    PageSection, Title, Card, CardTitle, CardBody, Content, Alert, Button, Form, FormGroup, TextInput,
    FormHelperText, HelperText, HelperTextItem, ActionGroup, List, ListItem, Flex, FlexItem,
} from "@patternfly/react-core";
import { CheckCircleIcon, ExclamationTriangleIcon, ExclamationCircleIcon } from "@patternfly/react-icons";
import type { NewDomain, SetupCheck, SetupStatus } from "../lib/types.ts";
import { previewProvision } from "../lib/domain.ts";
import { networkingPageAvailable, setupCheckText } from "../lib/setupText.ts";
import {
    validateRealm, realmViolationMessage, validateNetbiosDomain, netbiosDomainViolationMessage,
    validateForwarder, forwarderViolationMessage, ADMIN_PASSWORD_POLICY, adminPasswordContainsName,
} from "../lib/validators.ts";
import { checkPasswordAgainstPolicy } from "../lib/passwordUtils.ts";
import { PasswordField } from "./PasswordField.tsx";
import { ProvisionModal } from "./modals/ProvisionModal.tsx";

interface Props {
    status: SetupStatus;
    checking: boolean;
    onRecheck: () => void;
    onProvisioned: () => void;
}

function StateIcon({ state }: { state: SetupCheck["state"] }) {
    if (state === "ok") return <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" />;
    if (state === "warning")
        return <ExclamationTriangleIcon color="var(--pf-t--global--icon--color--status--warning--default)" />;
    return <ExclamationCircleIcon color="var(--pf-t--global--icon--color--status--danger--default)" />;
}

// The first label of the realm, as the NetBIOS name proposed while it is typed
function netbiosFromRealm(realm: string): string {
    return realm.trim().split(".")[0].toUpperCase().slice(0, 15);
}

export function SetupPage({ status, checking, onRecheck, onProvisioned }: Props) {
    const { t } = useTranslation();
    const hostName = status.host?.name ?? "";
    const [realm, setRealm] = useState((status.defaults?.realm ?? "").toLowerCase());
    const [netbios, setNetbios] = useState(status.defaults?.netbiosDomain ?? "");
    const [netbiosEdited, setNetbiosEdited] = useState(false);
    const [password, setPassword] = useState("");
    const [passwordConfirm, setPasswordConfirm] = useState("");
    const [forwarder, setForwarder] = useState(status.defaults?.dnsForwarder ?? "");
    const [touched, setTouched] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const [confirm, setConfirm] = useState<{ domain: NewDomain; commands: string[] } | null>(null);

    const titles: Record<SetupCheck["name"], string> = {
        smb_conf: t("Samba configuration"),
        address: t("Static address"),
        host_name: t("Host name"),
        ports: t("Network ports"),
        time: t("Time synchronization"),
        disk: t("Disk space"),
    };

    const realmViolation = validateRealm(realm, hostName);
    const netbiosViolation = validateNetbiosDomain(netbios, hostName);
    const forwarderViolation = validateForwarder(forwarder, status.host?.address ?? null);
    const passwordViolation = checkPasswordAgainstPolicy(ADMIN_PASSWORD_POLICY, password);

    function passwordMessage(): string | null {
        if (passwordViolation === "minLength") return t("The password must be at least 7 characters.");
        if (passwordViolation === "complexity")
            return t("The password must mix three of: lower-case letters, upper-case letters, digits, other characters.");
        if (adminPasswordContainsName(password)) return t("The password must not contain the account name.");
        return null;
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setTouched(true);
        setError(null);
        if (realmViolation || netbiosViolation || forwarderViolation || passwordMessage()) return;
        if (password !== passwordConfirm) { setError(t("Passwords do not match.")); return; }
        const domain: NewDomain = {
            realm: realm.trim().replace(/\.$/, "").toLowerCase(),
            netbiosDomain: netbios.trim().toUpperCase(),
            adminPassword: password,
            dnsForwarder: forwarder.trim(),
        };
        setPreviewing(true);
        try {
            setConfirm({ domain, commands: await previewProvision(domain) });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPreviewing(false);
        }
    }

    const fieldError = (message: string | null) => touched && message && (
        <FormHelperText>
            <HelperText><HelperTextItem variant="error">{message}</HelperTextItem></HelperText>
        </FormHelperText>
    );

    const networkingPage = networkingPageAvailable();
    const addressFailed = status.checks.some(c => c.name === "address" && c.state === "error");

    return (
        <>
            <PageSection>
                <Title headingLevel="h2" size="xl">{t("Set up a new domain")}</Title>
                <Content component="p">
                    {t("Samba is installed, but this host is not a domain controller yet. Check the prerequisites, then create a new domain with this host as its domain controller.")}
                </Content>
            </PageSection>
            <PageSection>
                <Card isPlain>
                    <CardTitle>{t("Prerequisites")}</CardTitle>
                    <CardBody>
                        <List isPlain>
                            {status.checks.map(c => {
                                const text = setupCheckText(t, c, networkingPage);
                                return (
                                    <ListItem key={c.name} icon={<StateIcon state={c.state} />}>
                                        <strong>{titles[c.name] ?? c.name}</strong>: {text.message}
                                        {text.fix && c.state !== "ok" && (
                                            <div className="pf-v6-u-font-size-sm pf-v6-u-text-color-subtle">{text.fix}</div>
                                        )}
                                    </ListItem>
                                );
                            })}
                        </List>
                        <Flex style={{ marginTop: "1rem" }}>
                            <FlexItem>
                                <Button variant="secondary" onClick={onRecheck} isLoading={checking} isDisabled={checking}>
                                    {t("Check again")}
                                </Button>
                            </FlexItem>
                            {addressFailed && networkingPage && (
                                <FlexItem>
                                    <Button variant="link" onClick={() => cockpit.jump("/network")}>
                                        {t("Open the Networking page")}
                                    </Button>
                                </FlexItem>
                            )}
                        </Flex>
                    </CardBody>
                </Card>
            </PageSection>
            <PageSection>
                <Card isPlain>
                    <CardTitle>{t("New domain")}</CardTitle>
                    <CardBody>
                        {!status.ready && (
                            <Alert variant="warning" isInline style={{ marginBottom: "1rem" }}
                                title={t("Fix the prerequisites marked as errors, then check again.")} />
                        )}
                        {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                        <Form onSubmit={handleSubmit} style={{ maxWidth: "40rem" }}>
                            <FormGroup label={t("Domain name")} isRequired fieldId="setup-realm">
                                <TextInput id="setup-realm" value={realm} isDisabled={!status.ready}
                                    placeholder="school.example.org"
                                    onChange={(_e, v) => {
                                        setRealm(v);
                                        if (!netbiosEdited) setNetbios(netbiosFromRealm(v));
                                    }} />
                                {fieldError(realmViolation && realmViolationMessage(t, realmViolation))}
                                {!(touched && realmViolation) && (
                                    <FormHelperText><HelperText><HelperTextItem>
                                        {t("The DNS name of the domain, also its Kerberos realm. This host becomes {{fqdn}}.",
                                           { fqdn: `${hostName}.${realm.trim().toLowerCase() || "…"}` })}
                                    </HelperTextItem></HelperText></FormHelperText>
                                )}
                            </FormGroup>
                            <FormGroup label={t("NetBIOS name of the domain")} isRequired fieldId="setup-netbios">
                                <TextInput id="setup-netbios" value={netbios} isDisabled={!status.ready}
                                    onChange={(_e, v) => { setNetbios(v.toUpperCase()); setNetbiosEdited(true); }} />
                                {fieldError(netbiosViolation && netbiosDomainViolationMessage(t, netbiosViolation))}
                            </FormGroup>
                            <FormGroup label={t("Administrator password")} isRequired fieldId="setup-password">
                                <PasswordField id="setup-password" label={t("Administrator password")} value={password} onChange={setPassword}
                                    isDisabled={!status.ready} isRequired />
                                {fieldError(passwordMessage())}
                            </FormGroup>
                            <FormGroup label={t("Confirm password")} isRequired fieldId="setup-password-confirm">
                                <PasswordField id="setup-password-confirm" label={t("Confirm password")} value={passwordConfirm}
                                    onChange={setPasswordConfirm} isDisabled={!status.ready} isRequired />
                            </FormGroup>
                            <FormGroup label={t("DNS forwarder")} isRequired fieldId="setup-forwarder">
                                <TextInput id="setup-forwarder" value={forwarder} isDisabled={!status.ready}
                                    onChange={(_e, v) => setForwarder(v)} />
                                {fieldError(forwarderViolation && forwarderViolationMessage(t, forwarderViolation))}
                                {!(touched && forwarderViolation) && (
                                    <FormHelperText><HelperText><HelperTextItem>
                                        {t("The DNS server that answers for the names outside the domain, such as the router's.")}
                                    </HelperTextItem></HelperText></FormHelperText>
                                )}
                            </FormGroup>
                            <Content component="small">
                                {t("The firewall is not changed: open the ports a domain controller needs (see the README).")}
                            </Content>
                            <ActionGroup>
                                <Button type="submit" variant="primary" isDisabled={!status.ready || previewing}
                                    isLoading={previewing}>
                                    {t("Create the domain")}
                                </Button>
                            </ActionGroup>
                        </Form>
                    </CardBody>
                </Card>
            </PageSection>
            {confirm && (
                <ProvisionModal domain={confirm.domain} commands={confirm.commands}
                    onClose={() => setConfirm(null)} onSuccess={onProvisioned} />
            )}
        </>
    );
}
