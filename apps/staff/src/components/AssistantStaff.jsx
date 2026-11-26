import { useEffect, useId, useState } from "react";
import LoadingStatus from "../../../../shared/ui/LoadingStatus.jsx";
import OperationalDialog from "./OperationalDialog.jsx";
import { CreateStaffForm, PrivateSetupHandoff } from "./StaffDirectory.jsx";
import { assignableRoles } from "../lib/staffManagement.js";
import { readRoles, createdNote } from "../lib/assistantStaff.js";
import { useTask } from "./useTask.js";
import { TEXT } from "./assistantText.js";

// Uses the Staff Directory's own form and private handoff. No password is ever
// chosen here, and the one-time code never enters the conversation.
export default function AssistantStaff({
  api,
  language,
  prefill,
  question,
  user,
  onSensitiveAction,
  onError,
  onDone,
}) {
  const t = TEXT[language],
    id = useId(),
    task = useTask(onError);
  const [directory, setDirectory] = useState(null),
    [handoff, setHandoff] = useState(null),
    [done, setDone] = useState(""),
    [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    task
      .run(() => api.staffDirectory())
      .then((result) => result && setDirectory(result));
  }, []);

  async function create(payload) {
    // The manager verification the directory asks for applies here too.
    const result = await task.run(() =>
      onSensitiveAction(() => api.createStaff(payload)),
    );
    if (!result) return;
    setHandoff(result);
    const note = createdNote(language, result);
    setDone(note);
    onDone(note);
  }

  if (done)
    return (
      <>
        <p role="status" className="staff-notice assistant-done">
          {done}
        </p>
        {handoff && (
          <OperationalDialog
            titleId="staff-handoff-title"
            busy={false}
            onClose={() => setHandoff(null)}
          >
            <PrivateSetupHandoff
              result={handoff}
              onClose={() => setHandoff(null)}
            />
          </OperationalDialog>
        )}
      </>
    );
  if (cancelled) return <p role="status">{t.cancelledForm}</p>;
  return (
    <div className="assistant-task" aria-labelledby={id} dir="ltr">
      {task.busy && <LoadingStatus label="Checking…" />}
      {task.error && (
        <p className="staff-error" role="alert">
          {task.error}
        </p>
      )}
      {directory && (
        <CreateStaffForm
          roles={assignableRoles(user, directory.roles)}
          departments={directory.departments}
          busy={task.busy}
          initial={{
            firstName: prefill.firstName,
            lastName: prefill.lastName,
            roles: readRoles(question),
          }}
          onSubmit={create}
          onCancel={() => setCancelled(true)}
        />
      )}
    </div>
  );
}
