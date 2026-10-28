import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Select, SelectList, SelectOption, SelectGroup,
    MenuToggle,
    SearchInput,
    Spinner,
    Button,
    ToggleGroup, ToggleGroupItem,
    Alert, Label,
} from "@patternfly/react-core";
import { Table, Thead, Tbody, Tr, Th, Td } from "@patternfly/react-table";
import { UserIcon, UsersIcon, TimesIcon } from "@patternfly/react-icons";
import { usePrincipals, type Principal } from "../lib/hooks.ts";
import type { ShareAccess, ShareAccessLevel } from "../lib/types.ts";

interface Props {
    access: ShareAccess[];
    onChange: (access: ShareAccess[]) => void;
    isDisabled?: boolean;
}

function samePrincipal(a: Principal, b: Principal): boolean {
    return a.kind === b.kind && a.name.toLowerCase() === b.name.toLowerCase();
}

export function PrincipalIcon({ kind }: { kind: "user" | "group" }) {
    const { t } = useTranslation();
    return kind === "group"
        ? <UsersIcon title={t("Group")} />
        : <UserIcon title={t("User")} />;
}

export function ShareAccessEditor({ access, onChange, isDisabled }: Props) {
    const { t } = useTranslation();
    const { principals, loading, error } = usePrincipals();
    const [open, setOpen] = useState(false);
    const [filterText, setFilterText] = useState("");

    const q = filterText.toLowerCase();
    const available = principals.filter(p =>
        !access.some(a => samePrincipal(a, p)) && p.name.toLowerCase().includes(q)
    );
    const groups = available.filter(p => p.kind === "group");
    const users = available.filter(p => p.kind === "user");

    function add(key: string) {
        const p = available.find(x => `${x.kind}:${x.name}` === key);
        if (p) onChange([...access, { ...p, level: "write" }]);
        setOpen(false);
        setFilterText("");
    }

    function setLevel(entry: ShareAccess, level: ShareAccessLevel) {
        onChange(access.map(a => (samePrincipal(a, entry) ? { ...a, level } : a)));
    }

    function remove(entry: ShareAccess) {
        onChange(access.filter(a => !samePrincipal(a, entry)));
    }

    return (
        <div>
            {error && <Alert variant="danger" isInline title={t("Failed to load users and groups")}>{error}</Alert>}
            <Select
                isOpen={open}
                onOpenChange={isOpen => { setOpen(isOpen); if (!isOpen) setFilterText(""); }}
                onSelect={(_e, value) => add(value as string)}
                toggle={ref => (
                    <MenuToggle
                        ref={ref}
                        onClick={() => setOpen(o => !o)}
                        isExpanded={open}
                        isDisabled={isDisabled || loading}
                        style={{ width: "100%" }}
                    >
                        {loading ? <Spinner size="sm" /> : t("Add user or group")}
                    </MenuToggle>
                )}
            >
                <div style={{ padding: "4px 8px" }}>
                    <SearchInput
                        value={filterText}
                        onChange={(_e, val) => setFilterText(val)}
                        onClear={() => setFilterText("")}
                        placeholder={t("Filter users and groups…")}
                        aria-label={t("Filter users and groups…")}
                        onClick={e => e.stopPropagation()}
                    />
                </div>
                <div style={{ maxHeight: "240px", overflowY: "auto" }}>
                    {available.length === 0 && (
                        <SelectList>
                            <SelectOption isDisabled value="">{t("No users or groups found")}</SelectOption>
                        </SelectList>
                    )}
                    {groups.length > 0 && (
                        <SelectGroup label={t("Groups")}>
                            <SelectList>
                                {groups.map(p => (
                                    <SelectOption key={`group:${p.name}`} value={`group:${p.name}`} icon={<UsersIcon />}>
                                        {p.name}
                                    </SelectOption>
                                ))}
                            </SelectList>
                        </SelectGroup>
                    )}
                    {users.length > 0 && (
                        <SelectGroup label={t("Users")}>
                            <SelectList>
                                {users.map(p => (
                                    <SelectOption key={`user:${p.name}`} value={`user:${p.name}`} icon={<UserIcon />}>
                                        {p.name}
                                    </SelectOption>
                                ))}
                            </SelectList>
                        </SelectGroup>
                    )}
                </div>
            </Select>

            {access.length > 0 && (
                <Table aria-label={t("Access list")} variant="compact" style={{ marginTop: "0.5rem" }}>
                    <Thead>
                        <Tr>
                            <Th>{t("User or group")}</Th>
                            <Th>{t("Permissions")}</Th>
                            <Th screenReaderText={t("Row actions")} />
                        </Tr>
                    </Thead>
                    <Tbody>
                        {access.map(a => (
                            <Tr key={`${a.kind}:${a.name}`}>
                                <Td dataLabel={t("User or group")}>
                                    <PrincipalIcon kind={a.kind} /> {a.name}
                                    {a.unknown && (
                                        <Label isCompact color="orange" style={{ marginLeft: "0.5rem" }}>{t("Deleted account")}</Label>
                                    )}
                                </Td>
                                <Td dataLabel={t("Permissions")}>
                                    <ToggleGroup isCompact aria-label={t("Permissions")}>
                                        <ToggleGroupItem
                                            text={t("Read only")}
                                            isSelected={a.level === "read"}
                                            isDisabled={isDisabled}
                                            onChange={() => setLevel(a, "read")}
                                        />
                                        <ToggleGroupItem
                                            text={t("Read and write")}
                                            isSelected={a.level === "write"}
                                            isDisabled={isDisabled}
                                            onChange={() => setLevel(a, "write")}
                                        />
                                    </ToggleGroup>
                                </Td>
                                <Td isActionCell>
                                    <Button
                                        variant="plain"
                                        aria-label={t("Remove {{name}}", { name: a.name })}
                                        icon={<TimesIcon />}
                                        isDisabled={isDisabled}
                                        onClick={() => remove(a)}
                                    />
                                </Td>
                            </Tr>
                        ))}
                    </Tbody>
                </Table>
            )}
            {access.some(a => a.unknown) && (
                <Alert variant="warning" isInline style={{ marginTop: "0.5rem" }}
                    title={t("Some entries name deleted accounts")}>
                    {t("Remove them: a new account created with the same name would get their access.")}
                </Alert>
            )}
        </div>
    );
}
