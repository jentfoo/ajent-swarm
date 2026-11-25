import type { ReactElement, ReactNode } from 'react'

import type { ChainForm } from './useChainForm'

// chainSubmitLabel names the submit action for both shells' footers.
export function chainSubmitLabel(editing: boolean, saving = false): string {
  if (saving) return editing ? 'Updating…' : 'Chaining…'
  return editing ? 'Update chain' : 'Chain sessions'
}

// ChainFields renders the shared chain editor body: the optional final
// prompt, the child prompt and the composed-line preview with its timing
// note. Both shells (the desktop modal and the mobile pushed screen) render
// it verbatim, each passing its own footer of submit affordances.
export function ChainFields({
  form,
  footer,
}: {
  form: ChainForm
  footer?: ReactNode
}): ReactElement {
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault()
        void form.submit()
      }}
    >
      <h2 className="modal-title">
        <span className="chain-name-chip">{form.parentName}</span>
        <span className="chain-link" aria-hidden="true">
          ⛓→
        </span>
        <span className="chain-name-chip">{form.childName}</span>
      </h2>
      <p className="muted small-note">
        {form.parentName} runs first, then hands its final prompt&rsquo;s answer to {form.childName}{' '}
        when one is set.
      </p>

      <label className="prompt-field">
        Final prompt for {form.parentName} (optional)
        <textarea
          rows={3}
          disabled={form.finalRunning}
          placeholder={`Ask ${form.parentName} one last thing. Its answer rides ${form.childName}'s prompt; leave empty and ${form.childName} runs its prompt alone.`}
          value={form.finalPrompt}
          onChange={(ev) => form.setFinalPrompt(ev.target.value)}
        />
      </label>
      {form.finalRunning && (
        <p className="muted small-note">
          This prompt already runs, only the child prompt may change.
        </p>
      )}

      <label className="prompt-field">
        Prompt for {form.childName}
        <textarea
          rows={4}
          placeholder={`What should ${form.childName} pick up? Empty sends "Continue from where ${form.parentName} left off."`}
          value={form.childPrompt}
          onChange={(ev) => form.setChildPrompt(ev.target.value)}
        />
      </label>

      <h3 className="section-title">The line {form.childName} receives</h3>
      <pre className="mono chain-preview">{form.preview}</pre>
      <p className="muted small-note">
        Only a final prompt&rsquo;s answer rides the line; without one no parent response is
        attached. {form.childName} starts once {form.parentName} is free of running turns, parked or
        queued prompts, and open dialogs, so it always sits in review first.
      </p>

      {form.error && (
        <p className="error-text" role="alert">
          {form.error}
        </p>
      )}
      {footer}
    </form>
  )
}
