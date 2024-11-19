const AWS = require('aws-sdk');
const sgMail = require('@sendgrid/mail');
const mysql = require('mysql2/promise');

// Initialize SendGrid with API key from environment variables
if (!process.env.SENDGRID_API_KEY) {
  console.error('SENDGRID_API_KEY environment variable is not set');
  throw new Error('Environment variable SENDGRID_API_KEY is required');
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Database configuration from environment variables
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// Initialize CloudWatch
const cloudwatch = new AWS.CloudWatch();

// Function to log metrics to CloudWatch (optional)
const logMetric = (metricName, value, unit = 'None') => {
  const params = {
    MetricData: [
      {
        MetricName: metricName,
        Dimensions: [{ Name: 'FunctionName', Value: 'emailVerificationLambda' }],
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
      console.log(`Metric ${metricName} pushed successfully`);
    }
  });
};

exports.handler = async (event) => {
  try {
    // Parse SNS message
    const message = JSON.parse(event.Records[0].Sns.Message);
    const { email, userId, activationLink } = message;

    // Log received message
    console.log(`Received SNS message for email: ${email}, userId: ${userId}`);

    // Send verification email
    await sendVerificationEmail(email, activationLink);

    // Log email in the database
    await logEmailSent(userId, email);

    // Optionally, log a metric
    logMetric('EmailsSent', 1, 'Count');

    return { status: 'Success' };
  } catch (error) {
    console.error('Error in Lambda function:', error);
    throw error;
  }
};

// Function to send verification email
async function sendVerificationEmail(email, activationLink) {
  try {
    const msg = {
      to: email,
      from: 'noreply@em2722.demo.csyeproject.me', // Replace with your verified sender email
      subject: 'Verify Your Email',
      text: `Please verify your email using this link: ${activationLink}`,
      html: `<p>Click <a href="${activationLink}">here</a> to verify your email.</p>`,
    };
    await sgMail.send(msg);
    console.log(`Verification email sent to ${email}`);
  } catch (error) {
    console.error('Failed to send verification email:', error);
    throw new Error(`Failed to send email to ${email}`);
  }
}

// Function to log email sent in the database
async function logEmailSent(userId, email) {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);

    const query = `
      UPDATE user
      SET email_sent_at = NOW(), email_status = 'sent'
      WHERE id = ?
    `;

    await connection.execute(query, [userId]);

    console.log(`Logged email sent to ${email} for user ID ${userId}`);
  } catch (error) {
    console.error('Failed to log email in database:', error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}