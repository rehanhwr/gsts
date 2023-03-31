
/**
 * Module dependencies.
 */

import { Parser } from './parser.js';
import { STSClient, AssumeRoleWithSAMLCommand } from '@aws-sdk/client-sts';
import { ProfileNotFoundError, RoleNotFoundError, RoleMismatchError } from './errors.js';
import { Session } from './session.js';
import { dirname, join } from 'node:path';
import { chmod, mkdir, readFile, writeFile, constants } from 'node:fs/promises';
import ini from 'ini';

// Regex pattern for duration seconds validation error.
const REGEX_PATTERN_DURATION_SECONDS = /value less than or equal to ([0-9]+)/

/**
 * Process a SAML response and extract all relevant data to be exchanged for an
 * STS token.
 */

export class CredentialsManager {
  constructor(logger, region, cacheDir) {
    this.logger = logger;
    this.parser = new Parser(logger);
    this.credentialsFile = cacheDir ? join(cacheDir, 'credentials') : null;
    this.stsClient = new STSClient({ region })
  }

  async prepareRoleWithSAML(samlResponse, customRoleArn) {
    const { roles, samlAssertion } = await this.parser.parseSamlResponse(samlResponse, customRoleArn);

    if (roles && roles.length) {
      roles.sort((a, b) => {
        if (a.roleArn < b.roleArn) {
          return -1;
        } else if (a.roleArn > b.roleArn) {
          return 1;
        }
        return 0;
      });
    }

    if (!customRoleArn) {
      this.logger.debug('A custom role ARN not been set so returning all parsed roles');

      return {
        roleToAssume: roles.length === 1 ? roles[0] : null,
        availableRoles: roles,
        samlAssertion
      }
    }

    const customRole = roles.find(role => role.roleArn === customRoleArn);

    if (!customRole) {
      throw new RoleNotFoundError(roles);
    }

    this.logger.debug('Found requested custom role ARN "%s" with principal ARN "%s"', customRole.roleArn, customRole.principalArn);

    return {
      roleToAssume: customRole,
      availableRoles: roles,
      samlAssertion
    }
  }

  /**
   * Parse SAML response and assume role-.
   */

  async assumeRoleWithSAML(samlAssertion, role, profile, customSessionDuration) {
    let sessionDuration = customSessionDuration || role.sessionDuration;
    let stsResponse;

    try {
      const assumeRoleCommand = {
        PrincipalArn: role.principalArn,
        RoleArn: role.roleArn,
        SAMLAssertion: samlAssertion
      };

      if (sessionDuration) {
        assumeRoleCommand.DurationSeconds = sessionDuration;
      }

      stsResponse = await this.stsClient.send(new AssumeRoleWithSAMLCommand(assumeRoleCommand));
    } catch (e) {
      if (REGEX_PATTERN_DURATION_SECONDS.test(e.message)) {
        let matches = e.message.match(REGEX_PATTERN_DURATION_SECONDS);
        let maxDuration = matches[1];
        if (maxDuration) {
          this.logger.warn(`Custom session duration ${customSessionDuration} exceeds maximum session duration of ${maxDuration} allowed for role. Please set --aws-session-duration=%d or $GSTS_AWS_SESSION_DURATION=%d to surpress this warning`);
        }
      }

      throw e;
    }

    this.logger.info('Role ARN "%s" has been assumed via SAML', role.roleArn);
    this.logger.debug('Role ARN "%s" AssumeRoleWithSAMLCommand response was %o', role.roleArn, stsResponse);

    const session = new Session({
      accessKeyId: stsResponse.Credentials.AccessKeyId,
      secretAccessKey: stsResponse.Credentials.SecretAccessKey,
      sessionToken: stsResponse.Credentials.SessionToken,
      expiresAt: new Date(stsResponse.Credentials.Expiration),
      role,
      samlAssertion,
      profile
    });

    if (this.credentialsFile) {
      await this.saveCredentials(profile, session);
    }

    return session;
  }

  /**
   * Save AWS credentials to a profile section.
   */

  async saveCredentials(profile, session) {
    let credentials;
    try {
      credentials = await this.getCredentialsFromFile();
    } catch (e) {
      // Credentials file not being found is an expected error.
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }

    let contents;
    if (credentials) {
      // Add new credential to existing credentials
      credentials[profile] = session.toIni(profile)[profile];
      contents = ini.encode(credentials);
    } else {
      // Init credentials
      contents = ini.encode(session.toIni(profile));
      await mkdir(dirname(this.credentialsFile), { recursive: true });
    }

    await writeFile(this.credentialsFile, contents);
    await chmod(this.credentialsFile, constants.S_IRUSR | constants.S_IWUSR);

    this.logger.info('The credentials have been stored in "%s" under AWS profile "%s"', this.credentialsFile, profile);
    this.logger.debug('Contents for credentials file "%s" is: \n %o', this.credentialsFile, contents);
  }

  /**
   * Load AWS credentials from the user home preferences.
   * Optionally accepts a AWS profile (usually a name representing
   * a section on the .ini-like file).
   */

  async loadCredentials(profile, roleArn) {
    const credentials = await this.getCredentialsFromFile();

    if (!credentials[profile]) {
      throw new ProfileNotFoundError(profile);
    }

    const session = Session.fromIni(credentials[profile]);

    if (roleArn && (roleArn !== session.role.roleArn))  {
      this.logger.warn(`Found profile "${profile}" credentials for a different role ARN (found "${session.role.roleArn}" != received "${roleArn}").`);

      throw new RoleMismatchError(roleArn, session.role.roleArn);
    }

    return session;
  }

  async getCredentialsFromFile() {
    if (!this.credentialsFile) {
      const error = new Error('ENOENT: no such file or directory');
      error.code = 'ENOENT';
      throw error;
    }

    let credentials;

    try {
      credentials = ini.parse(await readFile(this.credentialsFile, 'utf-8'));

      this.logger.info(`Loaded credentials from "${this.credentialsFile}".`);
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.logger.debug(`Credentials file not found at "${this.credentialsFile}".`)
      }

      throw e;
    }

    return credentials;
  }
}
