import ReactMarkdown from "react-markdown";

type MemoryMarkdownProps = {
  content: string;
};

export function MemoryMarkdown({ content }: MemoryMarkdownProps) {
  return (
    <div className="memory-markdown text-sm leading-6">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
