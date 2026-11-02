'use strict';

// Placeholder UI until the phase 07 frontend lands: bootstrap, login and
// logout against the real auth API.

const app = document.getElementById('app');

function heading(text, hint) {
	const h = document.createElement('h1');
	h.textContent = text;
	app.append(h);
	if (hint) {
		const p = document.createElement('p');
		p.className = 'hint';
		p.textContent = hint;
		app.append(p);
	}
}

function field(labelText, type, name, autofocus) {
	const label = document.createElement('label');
	label.textContent = labelText;
	const input = document.createElement('input');
	input.type = type;
	input.name = name;
	input.autocomplete = name === 'password' ? 'current-password' : 'username';
	if (autofocus) input.autofocus = true;
	label.append(input);
	app.append(label);
	return input;
}

function button(text) {
	const b = document.createElement('button');
	b.textContent = text;
	app.append(b);
	return b;
}

function errorLine() {
	const p = document.createElement('p');
	p.className = 'error';
	app.append(p);
	return p;
}

async function jsonPost(url, body) {
	const res = await fetch(url, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body),
	});
	if (res.status !== 204 && !res.ok) {
		let code = res.status;
		try {
			code = (await res.json()).error || code;
		} catch { /* body was not json */ }
		throw new Error(String(code));
	}
	return res;
}

function renderBootstrap() {
	heading('ajent-swarm', 'Set the first password for your account.');
	const pass1 = field('Password', 'password', 'password', true);
	const errorBox = errorLine();
	button('Save password').onclick = async () => {
		errorBox.textContent = '';
		try {
			await jsonPost('/api/auth/bootstrap', {password: pass1.value});
			location.reload();
		} catch (err) {
			errorBox.textContent = 'Failed: ' + err.message;
		}
	};
}

function renderLogin() {
	heading('ajent-swarm', 'Sign in with your unix account.');
	const user = field('Username', 'text', 'username', true);
	const pass = field('Password', 'password', 'password');
	const errorBox = errorLine();
	button('Sign in').onclick = async () => {
		errorBox.textContent = '';
		try {
			await jsonPost('/api/auth/login', {username: user.value, password: pass.value});
			location.reload();
		} catch (err) {
			errorBox.textContent = 'Login failed' + (err.message === 'invalid_credentials' ? '' : ': ' + err.message);
		}
	};
}

function renderSignedIn(username) {
	heading('ajent-swarm', 'Signed in as ' + username + '.');
	const note = document.createElement('p');
	note.className = 'hint';
	note.textContent = 'The session dashboard arrives with the next frontend phase.';
	app.append(note);
	button('Sign out').onclick = async () => {
		await fetch('/api/auth/logout', {method: 'POST'});
		location.reload();
	};
}

async function main() {
	let res;
	try {
		res = await fetch('/api/me');
	} catch {
		app.textContent = 'ajent-swarm is unreachable right now.';
		return;
	}
	if (res.status === 503) {
		renderBootstrap();
	} else if (res.ok) {
		const me = await res.json();
		renderSignedIn(me.username);
	} else {
		renderLogin();
	}
}

main();
