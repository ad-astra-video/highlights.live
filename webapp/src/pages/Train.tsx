import { NavLink, Outlet } from "react-router-dom";
import { BrainCircuit, Database, FlaskConical } from "lucide-react";

const subTab = `flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition ${
  "border-white/10 text-slate-ink hover:border-white/30"
}`;

const subTabActive = "border-neon/60 bg-neon/10 text-neon";

export function Train() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-purple/30 bg-dusk text-purple">
          <BrainCircuit className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Fine Tune</h1>
          <p className="text-sm text-mut">
            Train the Florence-2 &lt;OD&gt; LoRA runner from your curated dataset and download the trained adapter.
          </p>
        </div>
      </div>

      <nav className="mb-6 flex flex-wrap gap-2">
        <NavLink
          to="/app/train"
          end
          className={({ isActive }) => `${subTab} ${isActive ? subTabActive : ""}`}
        >
          <FlaskConical className="h-4 w-4" /> Fine Tune
        </NavLink>
        <NavLink
          to="/app/train/dataset"
          className={({ isActive }) => `${subTab} ${isActive ? subTabActive : ""}`}
        >
          <Database className="h-4 w-4" /> Dataset Curation
        </NavLink>
      </nav>

      <Outlet />
    </div>
  );
}
