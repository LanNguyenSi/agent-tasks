// Projects shared with a user who belongs to no team: one card per project,
// each opening its board. Used by /home and /projects for the zero-team state
// (no create or GitHub-sync controls: those need a team).

import Link from "next/link";
import type { Project } from "../../lib/api";
import { boardHref } from "../../lib/routes";
import Card from "../ui/Card";

export function SharedProjectsList({ projects }: { projects: Project[] }) {
  return (
    <div className="projects-grid">
      {projects.map((project) => (
        <Card key={project.id} interactive className="project-card">
          <Link href={boardHref({ projectId: project.id })} className="project-card-link">
            <div className="project-card-title-row">
              <h2 className="project-card-title">{project.name}</h2>
            </div>
            <p className="project-card-repo">
              {project.githubRepo ? `GitHub: ${project.githubRepo}` : "Manual project"}
            </p>
            {project.description && (
              <p className="project-card-desc">{project.description}</p>
            )}
          </Link>
        </Card>
      ))}
    </div>
  );
}
