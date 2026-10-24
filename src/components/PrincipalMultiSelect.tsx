import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Select, SelectList, SelectOption, SelectGroup,
    MenuToggle,
    LabelGroup, Label,
    Spinner,
    SearchInput,
    Alert,
} from "@patternfly/react-core";
import { usePrincipals } from "../lib/hooks.ts";
import { PrincipalIcon } from "./ShareAccessEditor.tsx";

interface Props {
    selected: string[];
    onChange: (names: string[]) => void;
    isDisabled?: boolean;
}

// Users and groups by account name, matched case-insensitively
export function PrincipalMultiSelect({ selected, onChange, isDisabled }: Props) {
    const { t } = useTranslation();
    const { principals, loading, error } = usePrincipals();
    const [open, setOpen] = useState(false);
    const [filterText, setFilterText] = useState("");

    const isSelected = (name: string) => selected.some(s => s.toLowerCase() === name.toLowerCase());
    const q = filterText.toLowerCase();
    const shown = principals.filter(p => p.name.toLowerCase().includes(q));
    const kindOf = (name: string) => principals.find(p => p.name.toLowerCase() === name.toLowerCase())?.kind;

    function toggle(name: string) {
        onChange(isSelected(name)
            ? selected.filter(s => s.toLowerCase() !== name.toLowerCase())
            : [...selected, name]);
    }

    function options(kind: "user" | "group") {
        return shown.filter(p => p.kind === kind).map(p => (
            <SelectOption key={`${kind}:${p.name}`} value={p.name} hasCheckbox isSelected={isSelected(p.name)}>
                {p.name}
            </SelectOption>
        ));
    }

    return (
        <div>
            {error && <Alert variant="danger" isInline title={t("Failed to load users and groups")}>{error}</Alert>}
            <Select
                isOpen={open}
                onOpenChange={isOpen => { setOpen(isOpen); if (!isOpen) setFilterText(""); }}
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
                onSelect={(_e, value) => toggle(value as string)}
            >
                <div style={{ padding: "4px 8px" }}>
                    <SearchInput
                        value={filterText}
                        onChange={(_e, val) => setFilterText(val)}
                        onClear={() => setFilterText("")}
                        placeholder={t("Filter users and groups…")}
                        onClick={e => e.stopPropagation()}
                    />
                </div>
                <SelectList style={{ maxHeight: "240px", overflowY: "auto" }}>
                    {shown.length === 0
                        ? <SelectOption isDisabled value="">{t("No users or groups found")}</SelectOption>
                        : (
                            <>
                                <SelectGroup label={t("Groups")}>{options("group")}</SelectGroup>
                                <SelectGroup label={t("Users")}>{options("user")}</SelectGroup>
                            </>
                        )}
                </SelectList>
            </Select>
            {selected.length > 0 && (
                <LabelGroup style={{ marginTop: "0.5rem" }} numLabels={10}>
                    {selected.map(name => {
                        const kind = kindOf(name);
                        return (
                            <Label
                                key={name}
                                icon={kind ? <PrincipalIcon kind={kind} /> : undefined}
                                onClose={isDisabled ? undefined : () => toggle(name)}
                            >
                                {name}
                            </Label>
                        );
                    })}
                </LabelGroup>
            )}
        </div>
    );
}
