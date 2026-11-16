import type { ModelState } from '../api/types'
import type { LaunchFormController } from '../hooks/useLaunchForm'
import { tildePath } from '../session/names'
import { ModelSelectOptions } from './ModelSelectOptions'

// WorkspaceSelect is the working-directory picker both launch forms share,
// with the custom-path reveal when no known workspace is chosen.
export function WorkspaceSelect({
  form,
  workspaceOptions,
  home,
  customPathTestId,
}: {
  form: Pick<
    LaunchFormController,
    'workspaceChoice' | 'setWorkspaceChoice' | 'customWorkspace' | 'setCustomWorkspace'
  >
  workspaceOptions: string[]
  home: string | undefined
  customPathTestId?: string
}) {
  return (
    <>
      <label>
        Working directory
        <select
          value={form.workspaceChoice}
          onChange={(ev) => form.setWorkspaceChoice(ev.target.value)}
        >
          <option value="">Custom path…</option>
          {workspaceOptions.map((w) => (
            <option key={w} value={w}>
              {tildePath(w, home)}
            </option>
          ))}
        </select>
      </label>
      {form.workspaceChoice === '' && (
        <label>
          Directory path
          <input
            placeholder="/home/you/project"
            value={form.customWorkspace}
            onChange={(ev) => form.setCustomWorkspace(ev.target.value)}
            data-testid={customPathTestId}
          />
        </label>
      )}
    </>
  )
}

// ModelSelect is the model picker both launch forms share.
export function ModelSelect({
  form,
  models,
}: {
  form: Pick<LaunchFormController, 'model' | 'setModel'>
  models: ModelState[]
}) {
  return (
    <label>
      Model
      <select value={form.model} onChange={(ev) => form.setModel(ev.target.value)}>
        <option value="">ajent default</option>
        <ModelSelectOptions models={models} />
      </select>
    </label>
  )
}
