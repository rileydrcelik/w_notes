# ECR: the private registry your container image is pushed to. The ECS task pulls
# from here. You build + push the image (see README) before the service can run.

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "MUTABLE"

  # Allow `terraform destroy` to delete the repo even though it holds images
  # (we push a fresh image on every rebuild anyway).
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "${local.name}-api" }
}

# Keep only the most recent images so the registry doesn't grow forever.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
