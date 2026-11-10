
import * as React from "react"

import { cn } from "@/lib/utils"

type ItemSpec = { value: string; label: string; disabled?: boolean }

type RootProps = {
  value?: string
  defaultValue?: string
  onValueChange?: (v: string) => void
  disabled?: boolean
  children?: React.ReactNode
}

// flatten arbitrary jsx (labels like `{t.label}{suffix}`) to the option text
function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children)
  return ""
}

// collect SelectItem descendants (through SelectContent/SelectGroup/fragments/maps)
function collectItems(children: React.ReactNode, out: ItemSpec[] = []): ItemSpec[] {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    const props = child.props as { value?: string; disabled?: boolean; children?: React.ReactNode }
    if (child.type === SelectItem) {
      out.push({ value: props.value ?? "", label: textOf(props.children), disabled: props.disabled })
      return
    }
    if (props.children) collectItems(props.children, out)
  })
  return out
}

function findTriggerClass(children: React.ReactNode): string {
  let cls = ""
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === SelectTrigger)
      cls = (child.props as { className?: string }).className || ""
  })
  return cls
}

const CHEVRON =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>\")"

const Select = ({ value, defaultValue, onValueChange, disabled, children }: RootProps) => {
  const items = collectItems(children)
  const triggerCls = findTriggerClass(children)
  return (
    <select
      value={value}
      defaultValue={value === undefined ? defaultValue : undefined}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
      className={cn(
        "h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-3 pr-8 text-sm text-foreground shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        triggerCls
      )}
      style={{ backgroundImage: CHEVRON, backgroundRepeat: "no-repeat", backgroundPosition: "right 0.6rem center" }}
    >
      {items.map((it) => (
        <option key={it.value} value={it.value} disabled={it.disabled}>
          {it.label}
        </option>
      ))}
    </select>
  )
}

/* the compound pieces are markers: Select parses them out of its children and they
 * never render themselves. Kept so every existing call site compiles unchanged. */
type MarkerProps = { className?: string; children?: React.ReactNode }

const SelectTrigger = (_props: MarkerProps) => null
SelectTrigger.displayName = "SelectTrigger"

const SelectValue = (_props: { placeholder?: string; className?: string }) => null
SelectValue.displayName = "SelectValue"

const SelectContent = (_props: MarkerProps & { position?: string }) => null
SelectContent.displayName = "SelectContent"

const SelectItem = (_props: MarkerProps & { value: string; disabled?: boolean }) => null
SelectItem.displayName = "SelectItem"

const SelectGroup = (_props: MarkerProps) => null
SelectGroup.displayName = "SelectGroup"

const SelectLabel = (_props: MarkerProps) => null
SelectLabel.displayName = "SelectLabel"

const SelectSeparator = (_props: MarkerProps) => null
SelectSeparator.displayName = "SelectSeparator"

const SelectScrollUpButton = (_props: MarkerProps) => null
SelectScrollUpButton.displayName = "SelectScrollUpButton"

const SelectScrollDownButton = (_props: MarkerProps) => null
SelectScrollDownButton.displayName = "SelectScrollDownButton"

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
}
