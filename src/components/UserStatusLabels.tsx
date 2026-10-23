import React from "react";
import { useTranslation } from "react-i18next";
import { Label, LabelGroup } from "@patternfly/react-core";
import type { User } from "../lib/types.ts";

// Account state labels: enabled or disabled, plus locked out and expired
export function UserStatusLabels({ user }: { user: User }) {
    const { t } = useTranslation();
    return (
        <LabelGroup>
            {user.status === "Active" ? (
                <Label color="green" isCompact>{t("Active")}</Label>
            ) : user.status === "Disabled" ? (
                <Label color="grey" isCompact>{t("Disabled")}</Label>
            ) : (
                <Label color="orange" isCompact>{t("Unknown")}</Label>
            )}
            {user.lockedOut && <Label color="red" isCompact>{t("Locked")}</Label>}
            {user.expired && <Label color="orange" isCompact>{t("Expired")}</Label>}
        </LabelGroup>
    );
}
