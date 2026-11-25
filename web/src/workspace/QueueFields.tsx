import type { ReactElement, ReactNode } from 'react'

import { useAuth } from '../providers/auth'
import { ModelSelect, WorkspaceSelect } from '../ui/LaunchFormFields'
import type { QueueFollowForm } from './useQueueFollowForm'

// queueSubmitLabel names the submit action for both shells' footers.
export function queueSubmitLabel(): string {
  return 'Queue follow up session'
}

// QueueFields renders the shared follow-up form body: the optional final
// prompt, the required start prompt, the composed-line preview with its
// timing note, and the launch facts for the session the submit creates. Both
// shells (the desktop modal and the mobile pushed screen) render it verbatim,
// each passing its own footer of submit affordances.
export function QueueFields({
  form,
  footer,
}: {
  form: QueueFollowForm
  footer?: ReactNode
}): ReactElement {
  const { home } = useAuth()
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
        <span className="chain-name-chip">
          {form.name.trim() !== '' ? form.name.trim() : 'new session'}
        </span>
      </h2>
      <p className="muted small-note">
        A fresh session launches right away and stays idle until {form.parentName} hands off. It
        runs the line below as its first prompt.
      </p>

      <label className="prompt-field">
        Final prompt for {form.parentName} (optional)
        <textarea
          rows={3}
          placeholder={`Ask ${form.parentName} one last thing. Its answer rides the follow-up's start prompt; leave empty and the follow-up runs its prompt alone.`}
          value={form.finalPrompt}
          onChange={(ev) => form.setFinalPrompt(ev.target.value)}
        />
      </label>

      <label className="prompt-field">
        Session start prompt (required)
        <textarea
          rows={4}
          placeholder={`What should the follow-up session begin with once ${form.parentName} finishes?`}
          value={form.startPrompt}
          onChange={(ev) => form.setStartPrompt(ev.target.value)}
        />
      </label>

      <h3 className="section-title">The line the follow-up session receives</h3>
      {form.preview !== '' ? (
        <pre className="mono chain-preview">{form.preview}</pre>
      ) : (
        <p className="muted small-note">The composed line appears as the start prompt fills in.</p>
      )}

      <h3 className="section-title">Follow-up session</h3>
      <label className="prompt-field">
        Session name (optional)
        <input
          placeholder="Labels it in the rail and switcher; empty names it from the start prompt"
          value={form.name}
          onChange={(ev) => form.setName(ev.target.value)}
        />
      </label>
      <WorkspaceSelect
        form={form}
        workspaceOptions={form.workspaceOptions}
        home={home}
        customPathTestId="queue-custom-workspace"
      />
      <ModelSelect form={form} models={form.models} />
      <p className="muted small-note">
        Only a final prompt&rsquo;s answer rides the line; without one no parent response is
        attached. The follow-up starts once {form.parentName} is free of running turns, parked or
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
