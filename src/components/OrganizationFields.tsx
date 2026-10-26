import React from "react";
import { useTranslation } from "react-i18next";
import { FormGroup, TextInput } from "@patternfly/react-core";

export interface Organization {
    description: string;
    title: string;
    department: string;
    company: string;
}

interface Props {
    idPrefix: string;
    values: Organization;
    onChange: { [K in keyof Organization]: (value: string) => void };
    isDisabled?: boolean;
}

// A user's description, job title, department and company: in the create
// modal and on the user page
export function OrganizationFields({ idPrefix, values, onChange, isDisabled }: Props) {
    const { t } = useTranslation();
    return (
        <>
            <FormGroup label={t("Description")} fieldId={`${idPrefix}-description`}>
                <TextInput id={`${idPrefix}-description`} value={values.description} isDisabled={isDisabled}
                    onChange={(_e, v) => onChange.description(v)} />
            </FormGroup>
            <FormGroup label={t("Job title")} fieldId={`${idPrefix}-title`}>
                <TextInput id={`${idPrefix}-title`} value={values.title} isDisabled={isDisabled}
                    onChange={(_e, v) => onChange.title(v)} />
            </FormGroup>
            <FormGroup label={t("Department")} fieldId={`${idPrefix}-department`}>
                <TextInput id={`${idPrefix}-department`} value={values.department} isDisabled={isDisabled}
                    onChange={(_e, v) => onChange.department(v)} />
            </FormGroup>
            <FormGroup label={t("Company")} fieldId={`${idPrefix}-company`}>
                <TextInput id={`${idPrefix}-company`} value={values.company} isDisabled={isDisabled}
                    onChange={(_e, v) => onChange.company(v)} />
            </FormGroup>
        </>
    );
}
