const AWS = require('aws-sdk');
const sgMail = require('@sendgrid/mail');
const mysql = require('mysql2/promise');

// Initialize AWS services
const cloudwatch = new AWS.CloudWatch();
const secretsManager = new AWS.SecretsManager();

// Constants
const FUNCTION_NAME = 'emailVerificationLambda';
const EMAIL_FROM = 'noreply@em2722.demo.csyeproject.me'; // Replace with your verified sender email

// Function to log metrics to CloudWatch
const logMetric = (metricName, value, unit = 'Count') => {
  const params = {
    MetricData: [
      {
        MetricName: metricName,
        Dimensions: [{ Name: 'FunctionName', Value: FUNCTION_NAME }],
        Unit: unit,
        Value: value,
      },
    ],
    Namespace: 'EmailVerificationMetrics',
  };

  cloudwatch.putMetricData(params, (err) => {
    if (err) {
      console.error(`Failed to push metric ${metricName}:`, err);
    } else {
      console.log(`Metric ${metricName} logged successfully`);
    }
  });
};

// Function to log errors as metrics
const logErrorMetric = (errorType) => {
  logMetric(errorType, 1, 'Count');
};

// Retrieve secret value from Secrets Manager
const getSecretValue = async (secretName) => {
  try {
    const data = await secretsManager.getSecretValue({ SecretId: secretName }).promise();
    return JSON.parse(data.SecretString);
  } catch (error) {
    console.error(`Error retrieving secret ${secretName}:`, error);
    logErrorMetric('SecretsManagerError');
    throw new Error(`Unable to retrieve secret ${secretName}`);
  }
};

// Retrieve database password from Secrets Manager
const getDbPassword = async () => {
  const secrets = await getSecretValue(process.env.DB_CREDENTIALS_SECRET_NAME);
  return secrets.password;
};

// Handler function
exports.handler = async (event) => {
  try {
    // Validate required environment variables
    const requiredEnvVars = [
      'DB_HOST',
      'DB_NAME',
      'DB_USER',
      'EMAIL_CREDENTIALS_SECRET_NAME',
      'REGION',
      'DB_CREDENTIALS_SECRET_NAME',
    ];

    for (const varName of requiredEnvVars) {
      if (!process.env[varName]) {
        throw new Error(`Environment variable ${varName} is not set`);
      }
    }

    // Retrieve email service credentials
    const emailSecrets = await getSecretValue(process.env.EMAIL_CREDENTIALS_SECRET_NAME);
    sgMail.setApiKey(emailSecrets.sendgrid_api_key);

    // Parse SNS message
    const message = JSON.parse(event.Records[0].Sns.Message);
    const { email, userId, activationLink } = message;

    // Log received message
    console.log(`Received SNS message for email: ${email}, userId: ${userId}`);

    // Send verification email
    await sendVerificationEmail(email, activationLink);

    // Log email in the database
    await logEmailSent(userId, email);

    // Log a metric for successful email sent
    logMetric('EmailsSent', 1, 'Count');

    return { status: 'Success' };
  } catch (error) {
    console.error('Error in Lambda function:', error);
    logErrorMetric('GeneralError');
    throw error;
  }
};

// Function to send verification email via SendGrid
const sendVerificationEmail = async (email, activationLink) => {
  try {
    const msg = {
      to: email,
      from: EMAIL_FROM,
      subject: 'Verify Your Email',
      text: `Please verify your email using this link: ${activationLink}`,
      html: `<p>Click <a href="${activationLink}">here</a> to verify your email.</p>`,
    };

    await sgMail.send(msg);
    console.log(`Verification email sent to ${email}`);
  } catch (error) {
    console.error('Failed to send verification email:', error);
    logErrorMetric('SendGridError');
    throw new Error(`Failed to send email to ${email}`);
  }
};

// Function to log email sent status in the database
const logEmailSent = async (userId, email) => {
  let connection;
  try {
    const dbPassword = await getDbPassword();
    const dbHost = process.env.DB_HOST;
    const dbName = process.env.DB_NAME;
    const dbUser = process.env.DB_USER;

    connection = await mysql.createConnection({
      host: dbHost,
      user: dbUser,
      password: dbPassword,
      database: dbName,
    });

    const query = `
      UPDATE user
      SET email_sent_at = NOW(), email_status = 'sent'
      WHERE id = ?
    `;

    const [result] = await connection.execute(query, [userId]);

    if (result.affectedRows === 0) {
      throw new Error(`No user found with ID ${userId}`);
    }

    console.log(`Logged email sent to ${email} for user ID ${userId}`);
  } catch (error) {
    console.error('Failed to log email in database:', error);
    logErrorMetric('DatabaseError');
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};
