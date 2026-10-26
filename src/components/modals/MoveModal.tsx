import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Alert, Button, Form, FormGroup, List, ListItem,
    Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant,
} from "@patternfly/react-core";
import { moveComputer, moveGroup, moveUser } from "../../lib/samba.ts";
import { mapLimit, BULK_CONCURRENCY } from "../../lib/concurrency.ts";
import { useOus } from "../../lib/hooks.ts";
import { ContainerSelect, accountContainers, sameContainer } from "../ContainerSelect.tsx";

export type MoveKind = "user" | "group" | "computer";

export interface MoveItem {
    name: string;
    container: string;
    // Built-in accounts and groups, domain controllers: they stay where they are
    fixed: boolean;
}

interface Props {
    kind: MoveKind;
    items: MoveItem[];
    onClose: () => void;
    onSuccess: () => void;
}

const MOVE: Record<MoveKind, (name: string, ou: string) => Promise<void>> = {
    user: moveUser, group: moveGroup, computer: moveComputer,
};

export function MoveModal({ kind, items, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const { ous, error: ousError } = useOus();
    const choices = accountContainers(ous);
    const first = items.find(i => !i.fixed);
    const [target, setTarget] = useState(items.length === 1 && first ? first.container : "");
    const [running, setRunning] = useState(false);
    const [failed, setFailed] = useState<Array<{ name: string; error: string }> | null>(null);
    const [moved, setMoved] = useState(0);

    const movable = items.filter(i => !i.fixed && !sameContainer(i.container, target));
    const fixed = items.filter(i => i.fixed);

    function title(): string {
        switch (kind) {
            case "user":     return t("Move users");
            case "group":    return t("Move groups");
            case "computer": return t("Move computers");
        }
    }

    async function handleMove() {
        setRunning(true);
        const settled = await mapLimit(movable, BULK_CONCURRENCY, async i => {
            try {
                await MOVE[kind](i.name, target);
                return { name: i.name, error: null };
            } catch (e) {
                return { name: i.name, error: e instanceof Error ? e.message : String(e) };
            }
        });
        setRunning(false);
        const errors = settled.filter(r => r.error !== null).map(r => ({ name: r.name, error: r.error as string }));
        if (errors.length === 0) { onSuccess(); return; }
        setMoved(settled.length - errors.length);
        setFailed(errors);
    }

    function handleClose() {
        if (failed && moved > 0) onSuccess();
        else onClose();
    }

    return (
        <Modal variant={ModalVariant.small} isOpen onClose={handleClose}>
            <ModalHeader title={title()} />
            <ModalBody>
                {ousError && <Alert variant="danger" isInline title={ousError} style={{ marginBottom: "1rem" }} />}
                {failed ? (
                    <>
                        {moved > 0 && (
                            <Alert variant="success" isInline title={t("objects_moved", { count: moved })}
                                style={{ marginBottom: "1rem" }} />
                        )}
                        {failed.map(f => (
                            <Alert key={f.name} variant="danger" isInline style={{ marginBottom: "0.5rem" }}
                                title={t("{{name}}: failed", { name: f.name })}>
                                {f.error}
                            </Alert>
                        ))}
                    </>
                ) : (
                    <Form>
                        <FormGroup label={t("Move to")} isRequired fieldId="mv-target">
                            <ContainerSelect id="mv-target" value={target} onChange={setTarget} choices={choices}
                                emptyLabel={target ? undefined : t("Choose a container")} isDisabled={running} />
                        </FormGroup>
                        {target && movable.length > 0 && (
                            <>
                                <p>{t("objects_will_be_moved", { count: movable.length })}</p>
                                <List style={{ maxHeight: "200px", overflowY: "auto" }}>
                                    {movable.map(i => <ListItem key={i.name}>{i.name}</ListItem>)}
                                </List>
                            </>
                        )}
                        {target && movable.length === 0 && fixed.length < items.length && (
                            <Alert variant="info" isInline title={t("Already in this container.")} />
                        )}
                        {fixed.length > 0 && (
                            <Alert variant="info" isInline title={t("objects_stay", { count: fixed.length })}>
                                {fixed.map(i => i.name).join(", ")}
                            </Alert>
                        )}
                    </Form>
                )}
            </ModalBody>
            <ModalFooter>
                {!failed && (
                    <Button variant="primary" isLoading={running} isDisabled={running || !target || movable.length === 0}
                        onClick={handleMove}>
                        {t("Move")}
                    </Button>
                )}
                <Button variant="link" isDisabled={running} onClick={handleClose}>
                    {failed ? t("Close") : t("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
}
