export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <div className="dark" style={{ colorScheme: "dark" }}>{children}</div>;
}
