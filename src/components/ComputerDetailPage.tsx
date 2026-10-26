import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
    Breadcrumb, BreadcrumbItem,
    PageBreadcrumb, PageSection,
    Title, Spinner, Alert,
    Card, CardTitle, CardBody,
    DescriptionList, DescriptionListGroup, DescriptionListTerm, DescriptionListDescription,
    Form, FormGroup, TextInput, ActionGroup, Button,
    Divider, Label,
} from "@patternfly/react-core";
import cockpit from "cockpit";
import { getComputerDetails, refreshComputer, setComputerDescription } from "../lib/samba.ts";
import type { Computer } from "../lib/types.ts";
import { ContainerLabel } from "./ContainerSelect.tsx";

interface Props {
    name: string;
}

export function ComputerDetailPage({ name }: Props) {
    const { t } = useTranslation();
    const [computer, setComputer] = useState<Computer | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        getComputerDetails(name)
            .then(c => { if (cancelled) return; setComputer(c); setLoading(false); })
            .catch(e => { if (cancelled) return; setLoadError(e instanceof Error ? e.message : String(e)); setLoading(false); });
        return () => { cancelled = true; };
    }, [name]);

    function goBack() { cockpit.location.go("/"); }

    return (
        <>
            <PageBreadcrumb hasBodyWrapper={false}>
                <Breadcrumb>
                    <BreadcrumbItem onClick={goBack} style={{ cursor: "pointer" }}>{t("Computers")}</BreadcrumbItem>
                    <BreadcrumbItem isActive>{name}</BreadcrumbItem>
                </Breadcrumb>
            </PageBreadcrumb>

            <PageSection hasBodyWrapper={false}>
                <Title headingLevel="h1">{computer?.name ?? name}</Title>
            </PageSection>

            {loading && (
                <PageSection hasBodyWrapper={false}>
                    <Spinner aria-label={t("Loading computer")} />
                </PageSection>
            )}

            {loadError && (
                <PageSection hasBodyWrapper={false}>
                    <Alert variant="danger" isInline title={t("Failed to load computer")}>{loadError}</Alert>
                </PageSection>
            )}

            {!loading && !loadError && computer && (
                <>
                    <PageSection hasBodyWrapper={false}>
                        <DetailsSection computer={computer} />
                    </PageSection>
                    <Divider />
                    <PageSection hasBodyWrapper={false}>
                        <DescriptionSection computer={computer} onUpdate={setComputer} />
                    </PageSection>
                </>
            )}
        </>
    );
}

function DetailsSection({ computer }: { computer: Computer }) {
    const { t } = useTranslation();
    const item = (term: string, value: React.ReactNode) => (
        <DescriptionListGroup>
            <DescriptionListTerm>{term}</DescriptionListTerm>
            <DescriptionListDescription>{value || "—"}</DescriptionListDescription>
        </DescriptionListGroup>
    );
    return (
        <Card isPlain>
            <CardTitle><Title headingLevel="h2" size="xl">{t("Details")}</Title></CardTitle>
            <CardBody>
                <DescriptionList isHorizontal>
                    {item(t("DNS name"), computer.dnsName)}
                    {item(t("OS"), computer.os === "-" ? "" : computer.os)}
                    {item(t("OS version"), computer.osVersion)}
                    {item(t("Last logon"), computer.lastLogon || t("Never"))}
                    {item(t("Container"), <ContainerLabel dn={computer.container} />)}
                    {item(t("ID"), computer.id)}
                    {item(t("SID"), computer.sid)}
                    {computer.isDomainController && item(t("Role"), <Label color="orange">{t("Domain controller")}</Label>)}
                </DescriptionList>
            </CardBody>
        </Card>
    );
}

function DescriptionSection({ computer, onUpdate }: { computer: Computer; onUpdate: (c: Computer) => void }) {
    const { t } = useTranslation();
    const [description, setDescription] = useState(computer.description);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    async function handleSave() {
        setSaving(true);
        setError(null);
        setSuccess(false);
        try {
            await setComputerDescription(computer.name, description.trim());
            const updated = await refreshComputer(computer.name);
            onUpdate(updated);
            setDescription(updated.description);
            setSuccess(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Card isPlain>
            <CardTitle><Title headingLevel="h2" size="xl">{t("Description")}</Title></CardTitle>
            <CardBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {success && <Alert variant="success" isInline title={t("Changes saved.")} style={{ marginBottom: "1rem" }} />}
                <Form isHorizontal>
                    <FormGroup label={t("Description")} fieldId="cd-description">
                        <TextInput id="cd-description" value={description} isDisabled={saving}
                            onChange={(_e, v) => { setDescription(v); setSuccess(false); }} />
                    </FormGroup>
                    <ActionGroup>
                        <Button variant="primary" isLoading={saving}
                            isDisabled={saving || description === computer.description} onClick={handleSave}>
                            {t("Save changes")}
                        </Button>
                    </ActionGroup>
                </Form>
            </CardBody>
        </Card>
    );
}
