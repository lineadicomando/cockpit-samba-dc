import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
    Alert,
    Button,
    Card,
    CardBody,
    CardTitle,
    CodeBlock,
    CodeBlockCode,
    Content,
    DescriptionList,
    DescriptionListDescription,
    DescriptionListGroup,
    DescriptionListTerm,
    ExpandableSection,
    Flex,
    FlexItem,
    Label,
    PageSection,
    Spinner,
    Stack,
    StackItem,
    Toolbar,
    ToolbarContent,
    ToolbarItem,
} from "@patternfly/react-core";
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table";
import type { IAction } from "@patternfly/react-table";

import { createBackup, getDomainInfo, listBackups, runHealthChecks } from "../lib/domain.ts";
import { forgetCachedData } from "../lib/exec.ts";
import { getPasswordPolicy, listPsos } from "../lib/samba.ts";
import type { DomainBackup, DomainInfo, HealthCheck, HealthCheckName, PasswordPolicy, Pso } from "../lib/types.ts";
import { DeletePsoModal } from "./modals/DeletePsoModal.tsx";
import { PasswordPolicyModal } from "./modals/PasswordPolicyModal.tsx";
import { PsoModal } from "./modals/PsoModal.tsx";
import { SysvolResetModal } from "./modals/SysvolResetModal.tsx";

const BACKUP_DIR = "/var/backups/samba-dc";
const CHECK_NAMES: HealthCheckName[] = ["dbcheck", "sysvolcheck", "testparm"];

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function fsmoLabel(t: TFunction, role: string): string {
    switch (role) {
        case "schema": return t("Schema master");
        case "naming": return t("Domain naming master");
        case "pdc": return t("PDC emulator");
        case "rid": return t("RID master");
        case "infrastructure": return t("Infrastructure master");
        case "domaindns": return t("Domain DNS zones master");
        case "forestdns": return t("Forest DNS zones master");
        default: return role;
    }
}

function checkLabel(t: TFunction, name: HealthCheckName): string {
    switch (name) {
        case "dbcheck": return t("Directory database");
        case "sysvolcheck": return t("Sysvol ACLs");
        case "testparm": return t("Samba configuration");
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function Overview({ info }: { info: DomainInfo }) {
    const { t } = useTranslation();
    const [processesOpen, setProcessesOpen] = useState(false);
    const rows: [string, string][] = [
        [t("Domain"), info.realm],
        [t("NetBIOS name"), info.netbiosDomain],
        [t("This server"), info.server],
        [t("Samba version"), info.sambaVersion],
        [t("Domain functional level"), info.domainLevel ?? t("Unknown")],
        [t("Forest functional level"), info.forestLevel ?? t("Unknown")],
    ];
    return (
        <Stack hasGutter>
            <StackItem>
                <DescriptionList isHorizontal isCompact>
                    {rows.map(([term, value]) => (
                        <DescriptionListGroup key={term}>
                            <DescriptionListTerm>{term}</DescriptionListTerm>
                            <DescriptionListDescription>{value}</DescriptionListDescription>
                        </DescriptionListGroup>
                    ))}
                </DescriptionList>
            </StackItem>
            <StackItem>
                <Table aria-label={t("Domain controllers")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th>{t("Domain controller")}</Th>
                            <Th>{t("DNS name")}</Th>
                            <Th>{t("Site")}</Th>
                        </Tr>
                    </Thead>
                    <Tbody>
                        {info.domainControllers.map(c => (
                            <Tr key={c.name}>
                                <Td dataLabel={t("Domain controller")}>{c.name}</Td>
                                <Td dataLabel={t("DNS name")}>{c.dnsName}</Td>
                                <Td dataLabel={t("Site")}>{c.site ?? ""}</Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            </StackItem>
            <StackItem>
                <Table aria-label={t("FSMO roles")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th>{t("FSMO role")}</Th>
                            <Th>{t("Owner")}</Th>
                        </Tr>
                    </Thead>
                    <Tbody>
                        {info.fsmo.map(f => (
                            <Tr key={f.role}>
                                <Td dataLabel={t("FSMO role")}>{fsmoLabel(t, f.role)}</Td>
                                <Td dataLabel={t("Owner")}>{f.owner ?? t("Unknown")}</Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            </StackItem>
            <StackItem>
                <ExpandableSection
                    toggleText={t("Samba processes")}
                    isExpanded={processesOpen}
                    onToggle={(_e, open) => setProcessesOpen(open)}
                >
                    {info.processes !== null
                        ? <CodeBlock><CodeBlockCode>{info.processes}</CodeBlockCode></CodeBlock>
                        : <Content component="p">{t("The list of processes is not available: is Samba running?")}</Content>}
                </ExpandableSection>
            </StackItem>
        </Stack>
    );
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------
function PasswordPolicyView({ refreshToken }: { refreshToken: number }) {
    const { t } = useTranslation();
    const [policy, setPolicy] = useState<PasswordPolicy | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [saved, setSaved] = useState(false);

    const load = useCallback(async () => {
        try {
            setPolicy(await getPasswordPolicy());
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    }, []);

    useEffect(() => { load(); }, [load, refreshToken]);

    if (error) return <Alert variant="danger" isInline title={t("Failed to load password policy.")}>{error}</Alert>;
    if (!policy) return <Spinner size="md" aria-label={t("Loading the password policy")} />;

    const never = t("Never");
    const rows: [string, string][] = [
        [t("Complexity"), policy.complexityRequired ? t("Required") : t("Not required")],
        [t("Minimum length"), t("policy_characters", { count: policy.minLength })],
        [t("Password history"), t("policy_passwords", { count: policy.historyLength })],
        [t("Minimum age"), t("policy_days", { count: policy.minAgeDays })],
        [t("Maximum age"), policy.maxAgeDays === null ? never : t("policy_days", { count: policy.maxAgeDays })],
        [t("Lockout threshold"), policy.lockoutThreshold === 0
            ? t("Accounts are never locked")
            : t("policy_failed_logons", { count: policy.lockoutThreshold })],
        [t("Lockout duration"), policy.lockoutDurationMinutes === null
            ? t("Until an administrator unlocks the account")
            : t("policy_minutes", { count: policy.lockoutDurationMinutes })],
        [t("Reset failed logons after"), policy.lockoutWindowMinutes === null
            ? never
            : t("policy_minutes", { count: policy.lockoutWindowMinutes })],
    ];
    return (
        <Stack hasGutter>
            <StackItem>
                <Flex alignItems={{ default: "alignItemsCenter" }}>
                    <FlexItem grow={{ default: "grow" }}>
                        <Content component="p">{t("The policy of the whole domain: it applies to every account without a fine-grained policy.")}</Content>
                    </FlexItem>
                    <FlexItem>
                        <Button variant="secondary" onClick={() => { setSaved(false); setEditing(true); }}>{t("Edit")}</Button>
                    </FlexItem>
                </Flex>
            </StackItem>
            {saved && (
                <StackItem>
                    <Alert variant="success" isInline title={t("Password policy saved")} />
                </StackItem>
            )}
            <StackItem>
                <DescriptionList isHorizontal isCompact>
                    {rows.map(([term, value]) => (
                        <DescriptionListGroup key={term}>
                            <DescriptionListTerm>{term}</DescriptionListTerm>
                            <DescriptionListDescription>{value}</DescriptionListDescription>
                        </DescriptionListGroup>
                    ))}
                </DescriptionList>
            </StackItem>
            {editing && (
                <PasswordPolicyModal
                    policy={policy}
                    onClose={() => setEditing(false)}
                    onSuccess={() => {
                        setEditing(false);
                        setSaved(true);
                        load();
                    }}
                />
            )}
        </Stack>
    );
}

// ---------------------------------------------------------------------------
// Fine-grained password policies
// ---------------------------------------------------------------------------
function PsoView({ refreshToken }: { refreshToken: number }) {
    const { t } = useTranslation();
    const [psos, setPsos] = useState<Pso[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ pso?: Pso; domainPolicy: PasswordPolicy } | null>(null);
    const [deleting, setDeleting] = useState<Pso | null>(null);
    const [opening, setOpening] = useState(false);

    const load = useCallback(async () => {
        try {
            setPsos(await listPsos());
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    }, []);

    useEffect(() => { load(); }, [load, refreshToken]);

    // A new PSO starts from the domain policy as it is now
    async function open(pso?: Pso) {
        setOpening(true);
        try {
            setEditing({ pso, domainPolicy: await getPasswordPolicy() });
        } catch (e) {
            setError(errorText(e));
        } finally {
            setOpening(false);
        }
    }

    function done() {
        setEditing(null);
        setDeleting(null);
        load();
    }

    const rowActions = (pso: Pso): IAction[] => [
        { title: t("Edit"), onClick: () => open(pso) },
        { title: t("Delete"), onClick: () => setDeleting(pso), isDanger: true },
    ];

    return (
        <Stack hasGutter>
            <StackItem>
                <Flex alignItems={{ default: "alignItemsCenter" }}>
                    <FlexItem grow={{ default: "grow" }}>
                        <Content component="p">
                            {t("A fine-grained policy replaces the domain policy for the users and groups it applies to.")}
                        </Content>
                    </FlexItem>
                    <FlexItem>
                        <Button variant="secondary" onClick={() => open()} isLoading={opening} isDisabled={opening}>
                            {t("Create policy")}
                        </Button>
                    </FlexItem>
                </Flex>
            </StackItem>
            {error && (
                <StackItem>
                    <Alert variant="danger" isInline title={t("Failed to load the fine-grained policies")}>{error}</Alert>
                </StackItem>
            )}
            <StackItem>
                {psos === null
                    ? !error && <Spinner size="md" aria-label={t("Loading the fine-grained policies")} />
                    : psos.length === 0
                        ? <Content component="p">{t("No fine-grained policies.")}</Content>
                        : (
                            <Table aria-label={t("Fine-grained password policies")} variant="compact">
                                <Thead>
                                    <Tr>
                                        <Th>{t("Name")}</Th>
                                        <Th>{t("Precedence")}</Th>
                                        <Th>{t("Minimum length")}</Th>
                                        <Th>{t("Maximum age")}</Th>
                                        <Th>{t("Lockout threshold")}</Th>
                                        <Th>{t("Applies to")}</Th>
                                        <Th screenReaderText={t("Row actions")} />
                                    </Tr>
                                </Thead>
                                <Tbody>
                                    {psos.map(p => (
                                        <Tr key={p.name}>
                                            <Td dataLabel={t("Name")}>{p.name}</Td>
                                            <Td dataLabel={t("Precedence")}>{p.precedence}</Td>
                                            <Td dataLabel={t("Minimum length")}>{t("policy_characters", { count: p.policy.minLength })}</Td>
                                            <Td dataLabel={t("Maximum age")}>
                                                {p.policy.maxAgeDays === null ? t("Never") : t("policy_days", { count: p.policy.maxAgeDays })}
                                            </Td>
                                            <Td dataLabel={t("Lockout threshold")}>
                                                {p.policy.lockoutThreshold === 0
                                                    ? t("Never")
                                                    : t("policy_failed_logons", { count: p.policy.lockoutThreshold })}
                                            </Td>
                                            <Td dataLabel={t("Applies to")}>
                                                {p.appliesTo.length > 0 ? p.appliesTo.join(", ") : t("Nobody")}
                                            </Td>
                                            <Td isActionCell>
                                                <ActionsColumn items={rowActions(p)} />
                                            </Td>
                                        </Tr>
                                    ))}
                                </Tbody>
                            </Table>
                        )}
            </StackItem>
            {editing && (
                <PsoModal pso={editing.pso} domainPolicy={editing.domainPolicy}
                    onClose={() => setEditing(null)} onSuccess={done} />
            )}
            {deleting && <DeletePsoModal pso={deleting} onClose={() => setDeleting(null)} onSuccess={done} />}
        </Stack>
    );
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------
function HealthChecks() {
    const { t } = useTranslation();
    const [results, setResults] = useState<Partial<Record<HealthCheckName, HealthCheck>>>({});
    const [running, setRunning] = useState<HealthCheckName[]>([]);
    const [expanded, setExpanded] = useState<HealthCheckName | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [resetOpen, setResetOpen] = useState(false);

    async function run(names: HealthCheckName[]) {
        setRunning(prev => [...prev, ...names]);
        setError(null);
        try {
            const checks = await runHealthChecks(names.length === CHECK_NAMES.length ? undefined : names);
            setResults(prev => {
                const next = { ...prev };
                for (const c of checks) next[c.name] = c;
                return next;
            });
        } catch (e) {
            setError(errorText(e));
        } finally {
            setRunning(prev => prev.filter(n => !names.includes(n)));
        }
    }

    function status(name: HealthCheckName) {
        if (running.includes(name)) return <Spinner size="md" aria-label={t("Running")} />;
        const result = results[name];
        if (!result) return <Label color="grey">{t("Not run")}</Label>;
        return result.ok
            ? <Label color="green">{t("Passed")}</Label>
            : <Label color="red">{t("Problems found")}</Label>;
    }

    const sysvolFailed = results.sysvolcheck && !results.sysvolcheck.ok;

    return (
        <Stack hasGutter>
            <StackItem>
                <Flex alignItems={{ default: "alignItemsCenter" }}>
                    <FlexItem grow={{ default: "grow" }}>
                        <Content component="p">
                            {t("The checks only report: nothing is repaired. The directory check can take a while.")}
                        </Content>
                    </FlexItem>
                    <FlexItem>
                        <Button variant="secondary" onClick={() => run(CHECK_NAMES)} isDisabled={running.length > 0}>
                            {t("Run all checks")}
                        </Button>
                    </FlexItem>
                </Flex>
            </StackItem>
            {error && (
                <StackItem>
                    <Alert variant="danger" isInline title={t("The checks could not run")}>{error}</Alert>
                </StackItem>
            )}
            {sysvolFailed && (
                <StackItem>
                    <Alert
                        variant="warning"
                        isInline
                        title={t("The ACLs of sysvol do not match what Samba expects")}
                        actionLinks={
                            <Button variant="link" isInline onClick={() => setResetOpen(true)}>
                                {t("Reset sysvol ACLs")}
                            </Button>
                        }
                    >
                        {t("Group Policy may fail on the clients until they are reset.")}
                    </Alert>
                </StackItem>
            )}
            <StackItem>
                <Table aria-label={t("Health checks")} variant="compact">
                    <Thead>
                        <Tr>
                            <Th>{t("Check")}</Th>
                            <Th>{t("Command")}</Th>
                            <Th>{t("Result")}</Th>
                            <Th screenReaderText={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {CHECK_NAMES.map(name => (
                            <Tr key={name}>
                                <Td dataLabel={t("Check")}>{checkLabel(t, name)}</Td>
                                <Td dataLabel={t("Command")}>
                                    <code>{results[name]?.command ?? name}</code>
                                </Td>
                                <Td dataLabel={t("Result")}>{status(name)}</Td>
                                <Td isActionCell modifier="nowrap">
                                    <Button variant="link" isInline onClick={() => run([name])}
                                        isDisabled={running.includes(name)}>
                                        {t("Run")}
                                    </Button>
                                    {results[name] && (
                                        <Button variant="link" isInline style={{ marginLeft: "1rem" }}
                                            onClick={() => setExpanded(expanded === name ? null : name)}>
                                            {expanded === name ? t("Hide output") : t("Show output")}
                                        </Button>
                                    )}
                                </Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            </StackItem>
            {expanded && results[expanded] && (
                <StackItem>
                    <CodeBlock>
                        <CodeBlockCode>{results[expanded]!.output || t("(no output)")}</CodeBlockCode>
                    </CodeBlock>
                </StackItem>
            )}
            {resetOpen && (
                <SysvolResetModal
                    onClose={() => setResetOpen(false)}
                    onSuccess={() => {
                        setResetOpen(false);
                        run(["sysvolcheck"]);
                    }}
                />
            )}
        </Stack>
    );
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------
function Backups({ refreshToken }: { refreshToken: number }) {
    const { t } = useTranslation();
    const [backups, setBackups] = useState<DomainBackup[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [created, setCreated] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setBackups(await listBackups());
            setError(null);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load, refreshToken]);

    async function create() {
        setCreating(true);
        setError(null);
        setCreated(null);
        try {
            const backup = await createBackup();
            setCreated(backup?.name ?? null);
            await load();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setCreating(false);
        }
    }

    return (
        <Stack hasGutter>
            <StackItem>
                <Flex alignItems={{ default: "alignItemsCenter" }}>
                    <FlexItem grow={{ default: "grow" }}>
                        <Content component="p">
                            {t("Offline backups of the domain go to {{dir}}, readable by root only: they hold the password hashes of every account.", { dir: BACKUP_DIR })}
                        </Content>
                    </FlexItem>
                    <FlexItem>
                        <Button variant="primary" onClick={create} isLoading={creating} isDisabled={creating}>
                            {creating ? t("Backing up…") : t("Create backup")}
                        </Button>
                    </FlexItem>
                </Flex>
            </StackItem>
            {created && (
                <StackItem>
                    <Alert variant="success" isInline title={t("Backup created: {{name}}", { name: created })} />
                </StackItem>
            )}
            {error && (
                <StackItem>
                    <Alert variant="danger" isInline title={t("Backup failed")}>{error}</Alert>
                </StackItem>
            )}
            <StackItem>
                {loading
                    ? <Spinner size="md" aria-label={t("Loading backups")} />
                    : backups.length === 0
                        ? <Content component="p">{t("No backups yet.")}</Content>
                        : (
                            <Table aria-label={t("Backups")} variant="compact">
                                <Thead>
                                    <Tr>
                                        <Th>{t("File")}</Th>
                                        <Th>{t("Size")}</Th>
                                        <Th>{t("Created")}</Th>
                                    </Tr>
                                </Thead>
                                <Tbody>
                                    {backups.map(b => (
                                        <Tr key={b.name}>
                                            <Td dataLabel={t("File")}>{b.name}</Td>
                                            <Td dataLabel={t("Size")}>{formatSize(b.size)}</Td>
                                            <Td dataLabel={t("Created")}>{new Date(b.created).toLocaleString()}</Td>
                                        </Tr>
                                    ))}
                                </Tbody>
                            </Table>
                        )}
            </StackItem>
            <StackItem>
                <Content component="small">
                    {t("Restoring a backup replaces the domain and is done by hand, with samba-tool domain backup restore (see the README).")}
                </Content>
            </StackItem>
        </Stack>
    );
}

// ---------------------------------------------------------------------------
// DomainPage
// ---------------------------------------------------------------------------
export function DomainPage() {
    const { t } = useTranslation();
    const [info, setInfo] = useState<DomainInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshToken, setRefreshToken] = useState(0);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setInfo(await getDomainInfo());
        } catch (e) {
            setError(errorText(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    function refresh() {
        forgetCachedData();
        setRefreshToken(n => n + 1);
        load();
    }

    return (
        <PageSection>
            <Toolbar>
                <ToolbarContent>
                    <ToolbarItem align={{ default: "alignEnd" }}>
                        <Button variant="secondary" onClick={refresh} isDisabled={loading}>{t("Refresh")}</Button>
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>
            <Stack hasGutter>
                <StackItem>
                    <Card>
                        <CardTitle>{t("Overview")}</CardTitle>
                        <CardBody>
                            {error && <Alert variant="danger" isInline title={t("Failed to load the domain")}>{error}</Alert>}
                            {loading && <Spinner size="lg" aria-label={t("Loading the domain")} />}
                            {!loading && info && <Overview info={info} />}
                        </CardBody>
                    </Card>
                </StackItem>
                <StackItem>
                    <Card>
                        <CardTitle>{t("Password policy")}</CardTitle>
                        <CardBody><PasswordPolicyView refreshToken={refreshToken} /></CardBody>
                    </Card>
                </StackItem>
                <StackItem>
                    <Card>
                        <CardTitle>{t("Fine-grained password policies")}</CardTitle>
                        <CardBody><PsoView refreshToken={refreshToken} /></CardBody>
                    </Card>
                </StackItem>
                <StackItem>
                    <Card>
                        <CardTitle>{t("Health checks")}</CardTitle>
                        <CardBody><HealthChecks /></CardBody>
                    </Card>
                </StackItem>
                <StackItem>
                    <Card>
                        <CardTitle>{t("Backups")}</CardTitle>
                        <CardBody><Backups refreshToken={refreshToken} /></CardBody>
                    </Card>
                </StackItem>
            </Stack>
        </PageSection>
    );
}
