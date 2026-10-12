// Every page comes in the same way: out of nothing, quietly.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
