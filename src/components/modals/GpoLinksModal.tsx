import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, Content, Flex, FlexItem, FormSelect, FormSelectOption, Modal, ModalBody, ModalFooter,
    ModalHeader, ModalVariant, Switch, Title,
} from "@patternfly/react-core";
import { Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table";

import { linkGpo, unlinkGpo } from "../../lib/gpos.ts";
import { listOus } from "../../lib/samba.ts";
import { useSingleLoad } from "../../lib/hooks.ts";
import type { Gpo, GpoLink } from "../../lib/types.ts";
import { ContainerLabel } from "../ContainerSelect.tsx";

interface Props { gpo: Gpo; onClose: () => void; }

// Each change is applied at once: a link is one attribute of its container
export function GpoLinksModal({ gpo: initial, onClose }: Props) {
    const { t } = useTranslation();
    const [gpo, setGpo] = useState(initial);
    const { items: ous } = useSingleLoad(listOus);
    const [target, setTarget] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const linked = new Set(gpo.links.map(l => l.container.toLowerCase()));
    // The domain or an OU (Domain Controllers too); AD applies no GPO to CN=Users or CN=Computers
    const places = [{ dn: "", label: t("Domain") },
        ...ous.filter(o => o.isOu).map(o => ({ dn: o.dn, label: o.path }))]
        .filter(p => !linked.has(p.dn.toLowerCase()));
    const chosen = target !== null && places.some(p => p.dn === target) ? target : places[0]?.dn ?? null;

    async function run(key: string, change: () => Promise<Gpo>) {
        setBusy(key);
        setError(null);
        try {
            setGpo(await change());
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    }

    const flag = (l: GpoLink, name: "enforced" | "disabled", value: boolean) =>
        run(`${l.container}\x1f${name}`, () => linkGpo(gpo.guid, l.container, { [name]: value }));

    return (
        <Modal variant={ModalVariant.medium} isOpen onClose={onClose}>
            <ModalHeader title={t("Links of {{name}}", { name: gpo.name })} description={gpo.guid} />
            <ModalBody>
                {error && <Alert variant="danger" isInline title={error} style={{ marginBottom: "1rem" }} />}
                {gpo.links.length === 0
                    ? <Content component="p">{t("This GPO is not linked: it applies nowhere.")}</Content>
                    : (
                        <Table aria-label={t("GPO links table")} variant="compact">
                            <Thead>
                                <Tr>
                                    <Th>{t("Linked to")}</Th>
                                    <Th info={{ tooltip: t("Precedence among the GPOs linked to the same place: 1 is the highest") }}>
                                        {t("Order")}
                                    </Th>
                                    <Th info={{ tooltip: t("Applies even where inheritance is blocked") }}>{t("Enforced")}</Th>
                                    <Th info={{ tooltip: t("The link stays, but the GPO does not apply there") }}>{t("Disabled")}</Th>
                                    <Th aria-label={t("Row actions")} />
                                </Tr>
                            </Thead>
                            <Tbody>
                                {gpo.links.map(l => (
                                    <Tr key={l.container}>
                                        <Td dataLabel={t("Linked to")}><ContainerLabel dn={l.container} /></Td>
                                        <Td dataLabel={t("Order")}>{l.order}</Td>
                                        <Td dataLabel={t("Enforced")}>
                                            <Switch id={`gpo-enforced-${l.container}`} aria-label={t("Enforced")}
                                                isChecked={l.enforced} isDisabled={busy !== null}
                                                onChange={(_e, v) => flag(l, "enforced", v)} />
                                        </Td>
                                        <Td dataLabel={t("Disabled")}>
                                            <Switch id={`gpo-disabled-${l.container}`} aria-label={t("Disabled")}
                                                isChecked={l.disabled} isDisabled={busy !== null || l.protected}
                                                onChange={(_e, v) => flag(l, "disabled", v)} />
                                        </Td>
                                        <Td isActionCell>
                                            {l.protected
                                                ? <span className="pf-v6-u-text-color-subtle" style={{ whiteSpace: "nowrap" }}
                                                    title={t("This link belongs to the domain and stays")}>{t("Always linked")}</span>
                                                : (
                                                    <Button variant="link" isDanger isInline isDisabled={busy !== null}
                                                        isLoading={busy === `${l.container}\x1funlink`}
                                                        onClick={() => run(`${l.container}\x1funlink`, () => unlinkGpo(gpo.guid, l.container))}>
                                                        {t("Remove link")}
                                                    </Button>
                                                )}
                                        </Td>
                                    </Tr>
                                ))}
                            </Tbody>
                        </Table>
                    )}

                <Title headingLevel="h4" size="md" style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>
                    {t("Link to")}
                </Title>
                {places.length === 0 && (
                    <Content component="p">{t("It is linked to the domain and to every OU.")}</Content>
                )}
                {places.length > 0 && <Flex alignItems={{ default: "alignItemsCenter" }}>
                    <FlexItem grow={{ default: "grow" }}>
                        <FormSelect id="gpo-link-target" value={chosen ?? ""} onChange={(_e, v) => setTarget(v)}
                            isDisabled={chosen === null || busy !== null} aria-label={t("Where to link it")}>
                            {places.map(p => <FormSelectOption key={p.dn} value={p.dn} label={p.label} />)}
                        </FormSelect>
                    </FlexItem>
                    <FlexItem>
                        <Button variant="secondary" isDisabled={chosen === null || busy !== null}
                            isLoading={busy === "link"}
                            onClick={() => chosen !== null && run("link", () => linkGpo(gpo.guid, chosen))}>
                            {t("Add link")}
                        </Button>
                    </FlexItem>
                </Flex>}
                <Content component="small" className="pf-v6-u-text-color-subtle"
                    style={{ display: "block", marginTop: "0.5rem" }}>
                    {t("A new link has the lowest precedence of its place. Windows clients apply the change at their next Group Policy refresh.")}
                </Content>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={onClose}>{t("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
}
