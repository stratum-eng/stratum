import { Hono } from "hono";
import { betaGateEnabled } from "../beta/gate";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  invalid_username:
    "Username must be 3-39 characters, lowercase letters, numbers, and hyphens only.",
  username_taken: "This username is already taken. Please choose another.",
  email_exists: "An account with this email already exists. Please sign in instead.",
  auth_config_missing: "Email authentication is not configured. Please contact the administrator.",
  auth_config_incomplete:
    "Email authentication is not fully configured. Please contact the administrator.",
  send_failed: "Failed to send email. Please try again later.",
  signup_failed: "Failed to create account. Please try again.",
  rate_limited: "Too many requests. Please try again later.",
  invite_required: "Stratum is in closed beta — an invite code is required to sign up.",
  invalid_invite: "That invite code isn't valid or has already been used.",
};

const SUCCESS_MESSAGES: Record<string, string> = {
  email_sent: "Check your email! We sent a magic link to complete your signup.",
};

// GET /auth/signup - Show signup form
app.get("/", (c) => {
  const errorCode = c.req.query("error");
  const successCode = c.req.query("success");
  const prefillEmail = c.req.query("email") ?? "";
  const betaGate = betaGateEnabled(c.env);
  const prefillInvite = c.req.query("ref") ?? c.req.query("invite") ?? "";
  const error =
    errorCode !== undefined
      ? (ERROR_MESSAGES[errorCode] ?? "Signup failed. Please try again.")
      : undefined;
  const success =
    successCode !== undefined
      ? (SUCCESS_MESSAGES[successCode] ?? "Success! Please check your email.")
      : undefined;

  return c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Create Account — Stratum</title>
        <link rel="stylesheet" href="/ui.css" />
        <style>{`
					.signup-container {
						max-width: 420px;
						margin: 3rem auto;
						padding: 2rem;
						background: #111;
						border-radius: 8px;
						border: 1px solid #1e1e1e;
					}
					.signup-header {
						text-align: center;
						margin-bottom: 1.5rem;
					}
					.signup-badge {
						display: inline-block;
						padding: 0.25rem 0.75rem;
						background: #1a3a6e;
						color: #7ca9f7;
						font-size: 0.75rem;
						font-weight: 600;
						text-transform: uppercase;
						letter-spacing: 0.05em;
						border-radius: 4px;
						margin-bottom: 1rem;
					}
					.signup-title {
						font-size: 1.5rem;
						font-weight: 700;
						color: #f0f0f0;
						margin-bottom: 0.5rem;
					}
					.signup-subtitle {
						color: #888;
						font-size: 0.9rem;
						line-height: 1.5;
					}
					.signup-form {
						display: flex;
						flex-direction: column;
						gap: 1.25rem;
					}
					.form-group {
						display: flex;
						flex-direction: column;
						gap: 0.5rem;
					}
					.form-label {
						font-size: 0.85rem;
						font-weight: 500;
						color: #ccc;
					}
					.form-label span {
						color: #666;
						font-weight: 400;
					}
					.form-input {
						padding: 0.75rem;
						background: #0a0a0a;
						border: 1px solid #333;
						border-radius: 4px;
						color: #f0f0f0;
						font-family: inherit;
						font-size: 0.95rem;
						transition: border-color 0.15s, box-shadow 0.15s;
					}
					.form-input:focus {
						outline: none;
						border-color: #7ca9f7;
						box-shadow: 0 0 0 2px rgba(124, 169, 247, 0.1);
					}
					.form-input.error {
						border-color: #f87171;
					}
					.form-input.success {
						border-color: #4ade80;
					}
					.form-input:disabled {
						opacity: 0.6;
						cursor: not-allowed;
					}
					.input-hint {
						font-size: 0.8rem;
						color: #666;
						display: flex;
						align-items: center;
						gap: 0.5rem;
					}
					.input-hint.error {
						color: #f87171;
					}
					.input-hint.success {
						color: #4ade80;
					}
					.username-status {
						display: flex;
						align-items: center;
						gap: 0.5rem;
						font-size: 0.85rem;
						min-height: 1.25rem;
					}
					.username-status.checking {
						color: #f7c97c;
					}
					.username-status.available {
						color: #4ade80;
					}
					.username-status.taken {
						color: #f87171;
					}
					.username-status.error {
						color: #f87171;
					}
					.status-icon {
						width: 16px;
						height: 16px;
						display: inline-flex;
						align-items: center;
						justify-content: center;
					}
					.spinner {
						width: 14px;
						height: 14px;
						border: 2px solid #333;
						border-top-color: #f7c97c;
						border-radius: 50%;
						animation: spin 1s linear infinite;
					}
					@keyframes spin {
						to { transform: rotate(360deg); }
					}
					.checkbox-group {
						display: flex;
						align-items: center;
						gap: 0.5rem;
						padding: 0.5rem 0;
					}
					.checkbox-input {
						width: 18px;
						height: 18px;
						accent-color: #7ca9f7;
						cursor: pointer;
					}
					.checkbox-label {
						font-size: 0.9rem;
						color: #ccc;
						cursor: pointer;
					}
					.submit-btn {
						padding: 0.875rem;
						background: #1a3a6e;
						border: 1px solid #2a5aae;
						border-radius: 4px;
						color: #f0f0f0;
						font-family: inherit;
						font-size: 1rem;
						font-weight: 600;
						cursor: pointer;
						transition: all 0.15s;
						margin-top: 0.5rem;
					}
					.submit-btn:hover:not(:disabled) {
						background: #1f4a8e;
						border-color: #3a6abe;
					}
				.submit-btn:disabled {
					opacity: 0.5;
					cursor: not-allowed;
					background: #1a1a1a;
					border-color: #333;
				}
				.submit-status {
					font-size: 0.85rem;
					color: #888;
					min-height: 1.25rem;
					text-align: center;
				}
				.auth-divider {
						text-align: center;
						margin: 1.5rem 0;
						color: #666;
						font-size: 0.85rem;
						position: relative;
					}
					.auth-divider::before,
					.auth-divider::after {
						content: "";
						position: absolute;
						top: 50%;
						width: 40%;
						height: 1px;
						background: #333;
					}
					.auth-divider::before { left: 0; }
					.auth-divider::after { right: 0; }
					.github-btn {
						display: flex;
						align-items: center;
						justify-content: center;
						gap: 0.5rem;
						padding: 0.75rem;
						background: #24292e;
						border: 1px solid #444;
						border-radius: 4px;
						color: #f0f0f0;
						font-family: inherit;
						font-size: 0.95rem;
						text-decoration: none;
						transition: all 0.15s;
					}
					.github-btn:hover {
						background: #2d333b;
						border-color: #555;
						text-decoration: none;
					}
					.github-icon {
						width: 20px;
						height: 20px;
						fill: currentColor;
					}
					.auth-footer {
						text-align: center;
						margin-top: 1.5rem;
						padding-top: 1.5rem;
						border-top: 1px solid #1e1e1e;
						color: #888;
						font-size: 0.9rem;
					}
					.auth-footer a {
						color: #7ca9f7;
						font-weight: 500;
					}
					.alert {
						padding: 1rem;
						border-radius: 4px;
						margin-bottom: 1.5rem;
						font-size: 0.9rem;
						line-height: 1.5;
					}
					.alert-error {
						background: rgba(248, 113, 113, 0.1);
						border: 1px solid rgba(248, 113, 113, 0.3);
						color: #f87171;
					}
					.alert-success {
						background: rgba(74, 222, 128, 0.1);
						border: 1px solid rgba(74, 222, 128, 0.3);
						color: #4ade80;
					}
					.success-state {
						text-align: center;
						padding: 2rem 1rem;
					}
					.success-icon {
						width: 64px;
						height: 64px;
						margin: 0 auto 1.5rem;
						background: rgba(74, 222, 128, 0.1);
						border: 2px solid rgba(74, 222, 128, 0.3);
						border-radius: 50%;
						display: flex;
						align-items: center;
						justify-content: center;
					}
					.success-icon svg {
						width: 32px;
						height: 32px;
						color: #4ade80;
					}
					.success-title {
						font-size: 1.25rem;
						font-weight: 600;
						color: #f0f0f0;
						margin-bottom: 0.75rem;
					}
					.success-message {
						color: #888;
						font-size: 0.95rem;
						line-height: 1.6;
						margin-bottom: 1.5rem;
					}
					.back-link {
						display: inline-block;
						color: #7ca9f7;
						font-size: 0.9rem;
						text-decoration: none;
					}
					.back-link:hover {
						text-decoration: underline;
					}
					@media (max-width: 480px) {
						.signup-container {
							margin: 1rem;
							padding: 1.5rem;
						}
					}
				`}</style>
      </head>
      <body>
        <nav class="nav">
          <a class="nav-brand" href="/">
            stratum
          </a>
        </nav>
        <main class="main">
          <div class="signup-container">
            {success ? (
              <div class="success-state">
                <div class="success-icon">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    role="img"
                    aria-label="Success"
                  >
                    <title>Success</title>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h2 class="success-title">Almost there!</h2>
                <p class="success-message">{success}</p>
                <a href="/" class="back-link">
                  Back to home
                </a>
              </div>
            ) : (
              <>
                <div class="signup-header">
                  <div class="signup-badge">New Account</div>
                  <p class="signup-subtitle">
                    Join Stratum to start managing your projects with AI-powered workflows.
                  </p>
                </div>

                {error && <div class="alert alert-error">{error}</div>}

                <form
                  class="signup-form"
                  action="/auth/email/send-signup"
                  method="post"
                  id="signupForm"
                >
                  <div class="form-group">
                    <label class="form-label" for="email">
                      Email address
                    </label>
                    <input
                      type="email"
                      id="email"
                      name="email"
                      class="form-input"
                      placeholder="you@example.com"
                      value={prefillEmail}
                      required
                      autocomplete="email"
                    />
                  </div>

                  <div class="form-group">
                    <label class="form-label" for="username">
                      Username <span>(your unique identifier)</span>
                    </label>
                    <input
                      type="text"
                      id="username"
                      name="username"
                      class="form-input"
                      placeholder="johndoe"
                      required
                      autocomplete="username"
                      minLength={3}
                      maxLength={39}
                      pattern="^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,38}$"
                      title="3-39 characters, lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen."
                    />
                    <div class="input-hint" id="usernameHint">
                      3-39 characters, lowercase letters, numbers, and hyphens
                    </div>
                    <div class="username-status" id="usernameStatus" />
                  </div>

                  {betaGate ? (
                    <div class="form-group">
                      <label class="form-label" for="inviteCode">
                        Invite code <span>(required during beta)</span>
                      </label>
                      <input
                        type="text"
                        id="inviteCode"
                        name="inviteCode"
                        class="form-input"
                        placeholder="ABCDE12345"
                        value={prefillInvite}
                        required
                        autocomplete="off"
                        spellcheck={false}
                      />
                      <div class="input-hint">
                        Have a referral link? Your code is filled in automatically.
                      </div>
                    </div>
                  ) : null}

                  <div class="checkbox-group">
                    <input
                      type="checkbox"
                      id="rememberMe"
                      name="rememberMe"
                      value="true"
                      class="checkbox-input"
                      checked
                    />
                    <label class="checkbox-label" for="rememberMe">
                      Keep me signed in for 30 days
                    </label>
                  </div>

                  <div class="submit-status" id="submitStatus" />
                  <button type="submit" class="submit-btn" id="submitBtn" disabled>
                    Create Account
                  </button>
                </form>

                <div class="auth-divider">or</div>

                <a href="/auth/github" class="github-btn">
                  <svg class="github-icon" viewBox="0 0 24 24" role="img" aria-label="GitHub">
                    <title>GitHub</title>
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  Continue with GitHub
                </a>

                <div class="auth-footer">
                  Already have an account? <a href="/auth/email">Sign in</a>
                </div>
              </>
            )}
          </div>
        </main>

        {!success && (
          <script
            dangerouslySetInnerHTML={{
              __html: SIGNUP_SCRIPT,
            }}
          />
        )}
      </body>
    </html>,
  );
});

// Client-side JavaScript for username validation
const SIGNUP_SCRIPT = `
(function() {
	const form = document.getElementById('signupForm');
	const usernameInput = document.getElementById('username');
	const emailInput = document.getElementById('email');
	const submitBtn = document.getElementById('submitBtn');
	const submitStatus = document.getElementById('submitStatus');
	const usernameHint = document.getElementById('usernameHint');
	const usernameStatus = document.getElementById('usernameStatus');

	let debounceTimer = null;
	let lastCheckedUsername = null;
	let isUsernameAvailable = false;
	let activeRequestId = 0;

	// Username validation regex: 3-39 chars, lowercase alphanumeric + hyphens, no start/end hyphen, no consecutive hyphens
	const USERNAME_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

	function validateUsernameFormat(username) {
		if (!username || username.length < 3) {
			return { valid: false, message: 'At least 3 characters required' };
		}
		if (username.length > 39) {
			return { valid: false, message: 'Maximum 39 characters allowed' };
		}
		if (username.startsWith('-')) {
			return { valid: false, message: 'Cannot start with a hyphen' };
		}
		if (username.endsWith('-')) {
			return { valid: false, message: 'Cannot end with a hyphen' };
		}
		if (username.includes('--')) {
			return { valid: false, message: 'No consecutive hyphens allowed' };
		}
		if (!USERNAME_REGEX.test(username)) {
			return { valid: false, message: 'Only lowercase letters, numbers, and hyphens allowed' };
		}
		return { valid: true, message: '' };
	}

	function updateUsernameStatus(status, message) {
		usernameStatus.className = 'username-status ' + status;
		
		if (status === 'checking') {
			usernameStatus.innerHTML = '<span class="spinner"></span> Checking availability...';
		} else if (status === 'available') {
			usernameStatus.innerHTML = '<span class="status-icon">&#10003;</span> ';
			usernameStatus.appendChild(document.createTextNode(message));
		} else if (status === 'taken') {
			usernameStatus.innerHTML = '<span class="status-icon">&#10007;</span> ';
			usernameStatus.appendChild(document.createTextNode(message));
		} else if (status === 'error') {
			usernameStatus.innerHTML = '<span class="status-icon">&#10007;</span> ';
			usernameStatus.appendChild(document.createTextNode(message));
		} else {
			usernameStatus.innerHTML = '';
		}
	}

	function setUsernameInputState(state) {
		usernameInput.className = 'form-input ' + state;
		if (state === 'error') {
			usernameHint.className = 'input-hint error';
		} else if (state === 'success') {
			usernameHint.className = 'input-hint success';
		} else {
			usernameHint.className = 'input-hint';
		}
	}

	function checkUsernameAvailability(username) {
		if (username === lastCheckedUsername) return;
		lastCheckedUsername = username;

		updateUsernameStatus('checking');
		setUsernameInputState('');

		// Debounce the API call
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}

		debounceTimer = setTimeout(async () => {
			const requestId = ++activeRequestId;
			try {
				// Check username availability via API
				const response = await fetch('/api/users/check-username?username=' + encodeURIComponent(username));
				const data = await response.json();

				// Ignore stale responses
				if (requestId !== activeRequestId || usernameInput.value.trim().toLowerCase() !== username) return;

				if (data.available) {
					isUsernameAvailable = true;
					updateUsernameStatus('available', 'Username is available!');
					setUsernameInputState('success');
				} else {
					isUsernameAvailable = false;
					updateUsernameStatus('taken', data.message || 'Username is already taken');
					setUsernameInputState('error');
				}
			} catch (error) {
				// Ignore stale responses
				if (requestId !== activeRequestId) return;
				// If API fails, allow submission anyway (server will validate)
				isUsernameAvailable = true;
				updateUsernameStatus('available', 'Looks good!');
				setUsernameInputState('success');
			}
			updateSubmitButton();
		}, 300);
	}

	function updateSubmitButton() {
		const email = emailInput.value.trim();
		const username = usernameInput.value.trim().toLowerCase();
		const formatValidation = validateUsernameFormat(username);
		
		// Enable submit button only if:
		// 1. Email is provided and valid
		// 2. Username passes format validation
		// 3. Username is available
		const isEmailValid = email.length > 0 && email.includes('@');
		const canSubmit = isEmailValid && formatValidation.valid && isUsernameAvailable;
		
		submitBtn.disabled = !canSubmit;
		
		// Show status message explaining why button is disabled
		if (canSubmit) {
			submitStatus.textContent = '';
		} else if (!email) {
			submitStatus.textContent = 'Please enter your email address';
		} else if (!isEmailValid) {
			submitStatus.textContent = 'Please enter a valid email address';
		} else if (!username) {
			submitStatus.textContent = 'Please enter a username';
		} else if (!formatValidation.valid) {
			submitStatus.textContent = formatValidation.message;
		} else if (!isUsernameAvailable) {
			submitStatus.textContent = 'Username is not available';
		}
	}

	// Real-time username validation
	usernameInput.addEventListener('input', function() {
		const username = this.value.trim().toLowerCase();
		const validation = validateUsernameFormat(username);
		
		if (username.length === 0) {
			updateUsernameStatus('', '');
			setUsernameInputState('');
			isUsernameAvailable = false;
		} else if (!validation.valid) {
			updateUsernameStatus('error', validation.message);
			setUsernameInputState('error');
			isUsernameAvailable = false;
		} else {
			// Format is valid, check availability
			checkUsernameAvailability(username);
		}
		
		updateSubmitButton();
	});

	// Email validation
	emailInput.addEventListener('input', function() {
		updateSubmitButton();
	});

	// Form submission
	form.addEventListener('submit', function(e) {
		const username = usernameInput.value.trim().toLowerCase();
		const validation = validateUsernameFormat(username);
		
		if (!validation.valid) {
			e.preventDefault();
			updateUsernameStatus('error', validation.message);
			setUsernameInputState('error');
			usernameInput.focus();
			return;
		}
		
		// Normalize username before submission
		usernameInput.value = username;
		
		// Disable button to prevent double submission
		submitBtn.disabled = true;
		submitBtn.textContent = 'Creating account...';
	});

	// Initial button state
	updateSubmitButton();
})();
`;

export { app as signupRouter };
