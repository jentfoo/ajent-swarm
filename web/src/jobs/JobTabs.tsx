import { Link } from 'react-router'

export function JobTabs({ active }: { active: 'jobs' | 'runs' }) {
  return (
    <nav className="job-tabs">
      <Link to="/jobs" className={active === 'jobs' ? 'active' : ''}>
        Jobs
      </Link>
      <Link to="/jobs/runs" className={active === 'runs' ? 'active' : ''}>
        Run history
      </Link>
    </nav>
  )
}
