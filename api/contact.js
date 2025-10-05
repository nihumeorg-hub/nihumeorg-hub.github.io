export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  try {
    const { fname, lname, email, phone, message } = req.body || {};
    if (!fname || !lname || !email || !message) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const TO_EMAIL = process.env.TO_EMAIL;
    const subject = 'Contact Inquiry from Website';
    const body = `Name: ${fname} ${lname}\nEmail: ${email}\nPhone: ${phone || ''}\n\nMessage:\n${message}`;

    if (RESEND_API_KEY && TO_EMAIL) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `Website <noreply@nihumeailabs.com>`,
          to: [TO_EMAIL],
          subject,
          text: body
        })
      });
      if (!r.ok) {
        const txt = await r.text();
        return res.status(502).json({ ok: false, error: 'Email provider error', detail: txt });
      }
      return res.status(200).json({ ok: true, message: 'Message sent successfully' });
    }

    // Fallback if not configured: accept but warn
    console.warn('Contact form received but email provider not configured. Set RESEND_API_KEY and TO_EMAIL.');
    return res.status(202).json({ ok: true, message: 'Received. We will get back soon.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
}

