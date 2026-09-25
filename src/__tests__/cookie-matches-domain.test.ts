import { cookieMatchesDomain } from '../../renderer/utils.js';

describe('cookieMatchesDomain', () => {
  it('matches an exact host', () => {
    expect(cookieMatchesDomain({ domain: 'example.com' }, 'example.com')).toBe(true);
  });

  it('matches a subdomain against a leading-dot domain cookie', () => {
    expect(cookieMatchesDomain({ domain: '.example.com' }, 'app.example.com')).toBe(true);
  });

  it('matches a subdomain against a bare domain cookie', () => {
    expect(cookieMatchesDomain({ domain: 'example.com' }, 'app.example.com')).toBe(true);
  });

  it('treats an empty cookie domain as host-only and always matching', () => {
    expect(cookieMatchesDomain({ domain: '' }, 'example.com')).toBe(true);
    expect(cookieMatchesDomain({}, 'example.com')).toBe(true);
  });

  it('always matches when no hostname is given', () => {
    expect(cookieMatchesDomain({ domain: 'example.com' }, '')).toBe(true);
  });

  it('does not match an unrelated hostname', () => {
    expect(cookieMatchesDomain({ domain: 'example.com' }, 'other.com')).toBe(false);
  });

  it('does not match a hostname that merely shares a suffix without a dot boundary', () => {
    expect(cookieMatchesDomain({ domain: 'example.com' }, 'notexample.com')).toBe(false);
  });
});
