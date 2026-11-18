/** 封装基于 Base UI 的控制台通用表单、勾选与折叠原语。 */
import { Checkbox } from "@base-ui/react/checkbox";
import { Collapsible } from "@base-ui/react/collapsible";
import { Select } from "@base-ui/react/select";
import { type ReactNode, useId } from "react";

export type SelectOption = Readonly<{
    value: string;
    label: string;
}>;

export function SelectField({
    id,
    label,
    labelClassName,
    ariaLabel,
    value,
    options,
    onChange,
    disabled,
}: {
    id?: string;
    label?: string;
    labelClassName?: string;
    ariaLabel?: string;
    value: string;
    options: readonly SelectOption[];
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    const generatedId = useId();
    const triggerId = id ?? generatedId;
    const items = options.map((option) => ({
        value: option.value,
        label: option.label,
    }));
    const control = (
        <Select.Root
            items={items}
            value={value}
            disabled={disabled}
            onValueChange={(next) => onChange(next ?? "")}
        >
            <Select.Trigger
                id={triggerId}
                aria-label={ariaLabel ?? label}
                className="ui-select-trigger"
            >
                <Select.Value className="ui-select-value" />
                <Select.Icon className="ui-select-icon" aria-hidden="true">
                    ▾
                </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
                <Select.Positioner
                    className="ui-select-positioner"
                    sideOffset={4}
                    alignItemWithTrigger={false}
                >
                    <Select.Popup className="ui-select-popup">
                        <Select.List className="ui-select-list">
                            {options.map((option) => (
                                <Select.Item
                                    key={option.value}
                                    value={option.value}
                                    className="ui-select-item"
                                >
                                    <Select.ItemIndicator className="ui-select-indicator">
                                        ✓
                                    </Select.ItemIndicator>
                                    <Select.ItemText className="ui-select-item-text">
                                        {option.label}
                                    </Select.ItemText>
                                </Select.Item>
                            ))}
                        </Select.List>
                    </Select.Popup>
                </Select.Positioner>
            </Select.Portal>
        </Select.Root>
    );
    if (!label) return control;
    return (
        <div
            className={
                labelClassName ? `ui-field ${labelClassName}` : "ui-field"
            }
        >
            <label htmlFor={triggerId}>{label}</label>
            {control}
        </div>
    );
}

export function CollapsibleSection({
    title,
    defaultOpen,
    open,
    onOpenChange,
    className,
    children,
}: {
    title: ReactNode;
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    className?: string;
    children: ReactNode;
}) {
    return (
        <Collapsible.Root
            className={
                className ? `ui-collapsible ${className}` : "ui-collapsible"
            }
            defaultOpen={defaultOpen}
            open={open}
            onOpenChange={onOpenChange}
        >
            <Collapsible.Trigger className="ui-collapsible-trigger">
                <span className="ui-collapsible-chevron" aria-hidden="true">
                    ▸
                </span>
                <span>{title}</span>
            </Collapsible.Trigger>
            <Collapsible.Panel className="ui-collapsible-panel">
                {children}
            </Collapsible.Panel>
        </Collapsible.Root>
    );
}

export function CheckboxField({
    checked,
    onCheckedChange,
    label,
    className,
}: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    label: string;
    className?: string;
}) {
    const id = useId();
    return (
        <label
            htmlFor={id}
            className={className ? `ui-check ${className}` : "ui-check"}
        >
            <Checkbox.Root
                id={id}
                checked={checked}
                onCheckedChange={onCheckedChange}
                className="ui-checkbox"
            >
                <Checkbox.Indicator className="ui-checkbox-indicator">
                    ✓
                </Checkbox.Indicator>
            </Checkbox.Root>
            <span>{label}</span>
        </label>
    );
}
