// JobsPlaceholder stands in until phase 10 delivers the job editor and run
// history screens; the scheduler API behind it is already live.
export default function JobsPlaceholder() {
  return (
    <>
      <h1 style={{ fontSize: 'inherit', marginTop: 0 }}>Jobs</h1>
      <p className="muted">
        Scheduled runs land in phase 10. The engine is running server-side; jobs can be managed
        through the REST API at <code>/api/jobs</code> meanwhile.
      </p>
    </>
  )
}
