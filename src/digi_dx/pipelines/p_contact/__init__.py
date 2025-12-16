"""
Pipeline for modeling contact success probability.

This pipeline models the probability of successful contact completion
(reaching signoff) given that we reply to a CQ with a certain SNR,
using Bayesian logistic regression.
"""

from .pipeline import create_pipeline

__all__ = ["create_pipeline"]

__version__ = "0.1"
