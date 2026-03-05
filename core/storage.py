import logging
import boto3
from botocore.exceptions import ClientError
from config import S3Config

logger = logging.getLogger(__name__)


class S3Client:
    def __init__(self, config: S3Config):
        self.bucket = config.bucket_name
        self.client = boto3.client(
            "s3",
            region_name=config.region,
            endpoint_url=config.endpoint_url,
        )
        logger.info(f"S3 client initialized — bucket: {self.bucket}, endpoint: {config.endpoint_url or 'AWS'}")

    def upload_blob(self, blob_hash: str, data: bytes) -> None:
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=f"blobs/{blob_hash}",
                Body=data,
            )
            logger.debug(f"Uploaded blob {blob_hash[:8]}... ({len(data)} bytes)")
        except ClientError as e:
            raise RuntimeError(f"Failed to upload blob {blob_hash[:8]}: {e}") from e

    def download_blob(self, blob_hash: str) -> bytes:
        try:
            response = self.client.get_object(
                Bucket=self.bucket,
                Key=f"blobs/{blob_hash}",
            )
            data = response["Body"].read()
            logger.debug(f"Downloaded blob {blob_hash[:8]}... ({len(data)} bytes)")
            return data
        except ClientError as e:
            raise RuntimeError(f"Failed to download blob {blob_hash[:8]}: {e}") from e

    def blob_exists_remote(self, blob_hash: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=f"blobs/{blob_hash}")
            return True
        except ClientError:
            return False

    def delete_blob(self, blob_hash: str) -> None:
        try:
            self.client.delete_object(Bucket=self.bucket, Key=f"blobs/{blob_hash}")
            logger.debug(f"Deleted blob {blob_hash[:8]}...")
        except ClientError as e:
            raise RuntimeError(f"Failed to delete blob {blob_hash[:8]}: {e}") from e