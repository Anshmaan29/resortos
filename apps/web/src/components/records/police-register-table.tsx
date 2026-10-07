'use client';

/** The police register exactly as it exports: the station's columns, one row per occupant (§58.2). */
export function PoliceRegisterTable({ columns, rows }: { columns: { key: string; label: string }[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto border-t border-border">
      <table className="w-full text-sm">
        <thead className="text-left text-text-3">
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c.key} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0 hover:bg-surface-2">
              {row.map((cell, j) => (
                <td key={j} className="whitespace-nowrap px-3 py-2 tabular-nums">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
