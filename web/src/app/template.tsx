// Every page comes in the same way: up a little, out of nothing.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
