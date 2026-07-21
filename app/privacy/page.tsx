import fs from 'fs';
import path from 'path';
import { renderPolicyHtml } from '@/lib/privacy';

export default async function PrivacyPage() {
  const filePath = path.join(process.cwd(), 'content/legal/privacy.md');
  const markdownContent = fs.readFileSync(filePath, 'utf8');
  const htmlContent = await renderPolicyHtml(markdownContent);

  return (
    <main style={{
      maxWidth: '800px',
      margin: '0 auto',
      padding: '40px 20px',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      lineHeight: '1.6',
      color: '#1a1a1a'
    }}>
      <div dangerouslySetInnerHTML={{ __html: htmlContent }} />
    </main>
  );
}
